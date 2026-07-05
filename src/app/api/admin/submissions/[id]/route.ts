import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-route-guard";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { deriveParkingType, haversineMetres } from "@/lib/parking-rules";
import type { ParkingRule, SpotSchedule, ExtractedParkingData } from "@/lib/parking-rules";

const MERGE_RADIUS_METRES = 15;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const supabase = createServiceRoleClient();
  const body = await request.json();
  const { action, reviewer_notes } = body as {
    action: "approve" | "reject";
    reviewer_notes?: string;
  };

  // ── Reject ─────────────────────────────────────────────────────────────────

  if (action === "reject") {
    const { error } = await supabase
      .from("sign_submissions")
      .update({ status: "rejected", reviewer_notes: reviewer_notes ?? null })
      .eq("id", id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // ── Approve ────────────────────────────────────────────────────────────────

  if (action === "approve") {
    const { data: sub, error: fetchError } = await supabase
      .from("sign_submissions")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });

    const extracted = sub.extracted_data as ExtractedParkingData | null;
    const newRules: ParkingRule[] = extracted?.rules ?? [];
    const parking_type = extracted?.parking_type ?? deriveParkingType(newRules);

    // Check for an existing parking spot within MERGE_RADIUS_METRES
    const latDelta = MERGE_RADIUS_METRES / 111_320;
    const lngDelta = MERGE_RADIUS_METRES / (111_320 * Math.cos((sub.latitude * Math.PI) / 180));

    const { data: nearby } = await supabase
      .from("parking_spots")
      .select("id, latitude, longitude, schedule")
      .gte("latitude",  sub.latitude  - latDelta)
      .lte("latitude",  sub.latitude  + latDelta)
      .gte("longitude", sub.longitude - lngDelta)
      .lte("longitude", sub.longitude + lngDelta)
      .eq("is_active", true);

    const closest = (nearby ?? [])
      .map((s) => ({
        ...s,
        dist: haversineMetres(sub.latitude, sub.longitude, s.latitude, s.longitude),
      }))
      .filter((s) => s.dist <= MERGE_RADIUS_METRES)
      .sort((a, b) => a.dist - b.dist)[0];

    let spotId: string;

    if (closest) {
      // ── Merge rules into existing spot ──────────────────────────────────────
      const existing = (closest.schedule as SpotSchedule | null)?.rules ?? [];
      const merged: ParkingRule[] = [...existing, ...newRules];

      const { error: updateErr } = await supabase
        .from("parking_spots")
        .update({
          schedule:          { rules: merged },
          parking_type:      deriveParkingType(merged),
          confidence_score:  Math.min((extracted?.confidence ?? 0.7), 1),
        })
        .eq("id", closest.id);

      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
      spotId = closest.id;
    } else {
      // ── Create new parking spot ──────────────────────────────────────────────
      const { data: spot, error: insertErr } = await supabase
        .from("parking_spots")
        .insert({
          latitude:          sub.latitude,
          longitude:         sub.longitude,
          parking_type,
          time_limit_minutes: extracted?.time_limit_minutes ?? null,
          cost_per_hour:      extracted?.cost_per_hour      ?? null,
          schedule:           { rules: newRules },
          source_type:        "user",
          confidence_score:   extracted?.confidence ?? 0.7,
          notes:              reviewer_notes ?? null,
        })
        .select("id")
        .single();

      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
      spotId = spot.id;
    }

    // Update submission status
    const { error: updateErr } = await supabase
      .from("sign_submissions")
      .update({
        status:          "approved",
        parking_spot_id: spotId,
        reviewer_notes:  reviewer_notes ?? null,
      })
      .eq("id", id);

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    // ── Write to training_examples (non-fatal) ────────────────────────────────
    await supabase.from("training_examples").insert({
      submission_id:           id,
      image_path:              sub.image_path,
      raw_text:                extracted?.raw_text ?? null,
      approved_extracted_data: extracted ?? null,
    });

    return NextResponse.json({
      ok: true,
      parking_spot_id: spotId,
      merged: !!closest,
    });
  }

  return NextResponse.json({ error: "invalid action" }, { status: 400 });
}
