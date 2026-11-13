import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/admin-route-guard";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { deriveParkingType, haversineMetres, mergeRules } from "@/lib/parking-rules";
import type { ParkingRule, SpotSchedule, ExtractedParkingData } from "@/lib/parking-rules";

const MERGE_RADIUS_METRES = 15;
const DEFAULT_CONFIDENCE = 0.7;
const PENDING = "pending_review";

type ReviewAction = "approve" | "reject";

type SubmissionRow = {
  id: string;
  image_path: string;
  latitude: number;
  longitude: number;
  extracted_data: ExtractedParkingData | null;
  reviewer_notes: string | null;
};

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_CONFIDENCE;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Moves the submission out of `pending_review` in one conditional UPDATE and
 * returns it. Returns null if it was not pending — already reviewed, or being
 * reviewed by a concurrent request — so a submission is only ever acted on once.
 */
async function claimSubmission(
  supabase: SupabaseClient,
  id: string,
  status: "approved" | "rejected",
  reviewerNotes: string | null,
): Promise<{ submission: SubmissionRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("sign_submissions")
    .update({ status, reviewer_notes: reviewerNotes })
    .eq("id", id)
    .eq("status", PENDING)
    .select("id, image_path, latitude, longitude, extracted_data, reviewer_notes")
    .maybeSingle();

  if (error) return { submission: null, error: error.message };
  return { submission: (data as SubmissionRow | null) ?? null, error: null };
}

/** Puts a claimed submission back in the queue after a failed approval. */
async function releaseSubmission(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase
    .from("sign_submissions")
    .update({ status: PENDING, parking_spot_id: null })
    .eq("id", id);

  if (error) {
    console.error(`[admin/submissions] could not return ${id} to the review queue:`, error.message);
  }
}

/** Merges the rules into a spot within MERGE_RADIUS_METRES, or creates a new spot. */
async function upsertSpot(
  supabase: SupabaseClient,
  sub: SubmissionRow,
  reviewerNotes: string | null,
): Promise<{ spotId: string; merged: boolean }> {
  const extracted = sub.extracted_data;
  const newRules: ParkingRule[] = Array.isArray(extracted?.rules) ? extracted.rules : [];
  const confidence = clampConfidence(extracted?.confidence);

  const latDelta = MERGE_RADIUS_METRES / 111_320;
  const lngDelta = MERGE_RADIUS_METRES / (111_320 * Math.cos((sub.latitude * Math.PI) / 180));

  const { data: nearby, error: nearbyError } = await supabase
    .from("parking_spots")
    .select("id, latitude, longitude, schedule, confidence_score")
    .gte("latitude",  sub.latitude  - latDelta)
    .lte("latitude",  sub.latitude  + latDelta)
    .gte("longitude", sub.longitude - lngDelta)
    .lte("longitude", sub.longitude + lngDelta)
    .eq("is_active", true);

  if (nearbyError) throw new Error(nearbyError.message);

  const closest = (nearby ?? [])
    .map((s) => ({
      ...s,
      dist: haversineMetres(sub.latitude, sub.longitude, s.latitude, s.longitude),
    }))
    .filter((s) => s.dist <= MERGE_RADIUS_METRES)
    .sort((a, b) => a.dist - b.dist)[0];

  if (closest) {
    // Same pole photographed again: add only the rules the spot does not have yet
    const existing = (closest.schedule as SpotSchedule | null)?.rules ?? [];
    const merged = mergeRules(existing, newRules);

    const { error } = await supabase
      .from("parking_spots")
      .update({
        schedule:         { rules: merged },
        parking_type:     deriveParkingType(merged),
        confidence_score: Math.max(clampConfidence(closest.confidence_score), confidence),
      })
      .eq("id", closest.id);

    if (error) throw new Error(error.message);
    return { spotId: closest.id as string, merged: true };
  }

  const rules = mergeRules([], newRules);
  const { data: spot, error } = await supabase
    .from("parking_spots")
    .insert({
      latitude:           sub.latitude,
      longitude:          sub.longitude,
      parking_type:       deriveParkingType(rules),
      time_limit_minutes: extracted?.time_limit_minutes ?? null,
      cost_per_hour:      extracted?.cost_per_hour      ?? null,
      schedule:           { rules },
      source_type:        "user",
      confidence_score:   confidence,
      notes:              reviewerNotes,
    })
    .select("id")
    .single();

  if (error || !spot) throw new Error(error?.message ?? "Spot was not created");
  return { spotId: spot.id as string, merged: false };
}

/** Saves an approved extraction as a few-shot example. Never fails the request. */
async function recordTrainingExample(supabase: SupabaseClient, sub: SubmissionRow): Promise<void> {
  const extracted = sub.extracted_data;
  // An example with no text or no rules teaches the model nothing
  if (!extracted?.raw_text?.trim() || !Array.isArray(extracted.rules) || extracted.rules.length === 0) {
    return;
  }

  const { error } = await supabase.from("training_examples").insert({
    submission_id:           sub.id,
    image_path:              sub.image_path,
    raw_text:                extracted.raw_text,
    approved_extracted_data: extracted,
  });

  if (error) {
    console.error(`[admin/submissions] training example for ${sub.id} was not saved:`, error.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;

  let body: { action?: unknown; reviewer_notes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const action = body?.action;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  const reviewAction: ReviewAction = action;
  const reviewerNotes =
    typeof body.reviewer_notes === "string" && body.reviewer_notes.trim() !== ""
      ? body.reviewer_notes.trim()
      : null;

  const supabase = createServiceRoleClient();

  // ── Claim the submission (only one review can ever succeed) ────────────────
  const { submission, error: claimError } = await claimSubmission(
    supabase,
    id,
    reviewAction === "approve" ? "approved" : "rejected",
    reviewerNotes,
  );

  if (claimError) return NextResponse.json({ error: claimError }, { status: 500 });
  if (!submission) {
    return NextResponse.json(
      { error: "This submission has already been reviewed or does not exist." },
      { status: 409 },
    );
  }

  if (reviewAction === "reject") return NextResponse.json({ ok: true });

  // ── Approve: put the rules on the map, then link the submission ────────────
  let spotId: string;
  let merged: boolean;
  try {
    ({ spotId, merged } = await upsertSpot(supabase, submission, reviewerNotes));
  } catch (err) {
    await releaseSubmission(supabase, id);
    const message = err instanceof Error ? err.message : "Could not update the map";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const { error: linkError } = await supabase
    .from("sign_submissions")
    .update({ parking_spot_id: spotId })
    .eq("id", id);

  if (linkError) {
    // The spot is live and the submission is approved; only the link is missing.
    console.error(`[admin/submissions] could not link ${id} to spot ${spotId}:`, linkError.message);
  }

  await recordTrainingExample(supabase, submission);

  return NextResponse.json({ ok: true, parking_spot_id: spotId, merged });
}
