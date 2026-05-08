import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase-server";

// PATCH /api/admin/spots/[id] — edit a spot's attributes
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createServiceRoleClient();
  const body = await req.json();

  // Only allow editing safe fields — latitude/longitude locked to prevent silent map drift
  const allowed = [
    "parking_type",
    "street_name",
    "from_street",
    "to_street",
    "time_limit_minutes",
    "cost_per_hour",
    "notes",
  ] as const;

  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) patch[key] = body[key] === "" ? null : body[key];
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("parking_spots")
    .update(patch)
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/spots/[id] — full lifecycle delete
//
// DB handles automatically via FK rules:
//   - parking_spot_history  (ON DELETE CASCADE)
//   - reports               (ON DELETE CASCADE)
//   - sign_submissions.parking_spot_id (ON DELETE SET NULL)
//
// We manually reset sign_submissions.status → pending_review first,
// because SET NULL only clears the FK — it doesn't touch the status field.
// Sign images in storage are kept for audit trail.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createServiceRoleClient();

  // Reset linked submissions to pending_review before the spot is deleted.
  // The subsequent spot deletion will SET NULL on parking_spot_id via the FK rule.
  const { error: resetError } = await supabase
    .from("sign_submissions")
    .update({
      status: "pending_review",
      reviewer_notes: "Spot was deleted by admin — resubmitted for review",
    })
    .eq("parking_spot_id", id);

  if (resetError) {
    return NextResponse.json({ error: `Failed to reset submissions: ${resetError.message}` }, { status: 500 });
  }

  // Delete the spot — Postgres CASCADE handles parking_spot_history and reports.
  const { error: deleteError } = await supabase
    .from("parking_spots")
    .delete()
    .eq("id", id);

  if (deleteError) {
    return NextResponse.json({ error: `Failed to delete spot: ${deleteError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
