import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin } from "@/lib/admin-route-guard";
import { createServiceRoleClient } from "@/lib/supabase-server";
import type { ExtractedParkingData } from "@/lib/parking-rules";

type Approval = {
  status: "approved";
  parking_spot_id: string;
  merged: boolean;
  image_path: string;
  extracted_data: ExtractedParkingData | null;
};

type Review = Approval | { status: "rejected" };

async function recordTrainingExample(supabase: SupabaseClient, id: string, approval: Approval) {
  const extracted = approval.extracted_data;
  if (typeof extracted?.raw_text !== "string" || !extracted.raw_text.trim() ||
    !Array.isArray(extracted.rules) || extracted.rules.length === 0) return;

  const { error } = await supabase.from("training_examples").insert({
    submission_id: id,
    image_path: approval.image_path,
    raw_text: extracted.raw_text,
    approved_extracted_data: extracted,
  });

  if (error) console.error(`[admin/submissions] Could not save training example for ${id}`, error.code);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = await requireAdmin(request);
  if (unauthorized) return unauthorized;

  let body: { action?: unknown; reviewer_notes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const action = body?.action;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const { id } = await params;
  const notes = typeof body.reviewer_notes === "string" ? body.reviewer_notes.trim() || null : null;
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("review_sign_submission", {
    p_submission_id: id,
    p_action: action,
    p_reviewer_notes: notes,
  });

  if (error) {
    console.error(`[admin/submissions] Could not review ${id}`, error.code);
    return NextResponse.json({ error: "Could not review this submission." }, { status: 500 });
  }

  const review = data as Review | null;
  if (!review) {
    return NextResponse.json({ error: "This submission has already been reviewed or does not exist." }, { status: 409 });
  }
  if (review.status === "rejected") return NextResponse.json({ ok: true });

  await recordTrainingExample(supabase, id, review);
  return NextResponse.json({ ok: true, parking_spot_id: review.parking_spot_id, merged: review.merged });
}
