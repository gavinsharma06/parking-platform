import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase-server";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = createServiceRoleClient();
  const body = await request.json();
  const { action, reviewer_notes } = body as {
    action: "approve" | "reject";
    reviewer_notes?: string;
  };

  if (action === "reject") {
    const { error } = await supabase
      .from("sign_submissions")
      .update({ status: "rejected", reviewer_notes: reviewer_notes ?? null })
      .eq("id", id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "approve") {
    const { data: sub, error: fetchError } = await supabase
      .from("sign_submissions")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    const extracted = (sub.extracted_data ?? {}) as Record<string, unknown>;

    const { data: spot, error: spotError } = await supabase
      .from("parking_spots")
      .insert({
        latitude: sub.latitude,
        longitude: sub.longitude,
        parking_type: extracted.parking_type ?? "unknown",
        time_limit_minutes: extracted.time_limit_minutes ?? null,
        cost_per_hour: extracted.cost_per_hour ?? null,
        schedule: extracted.schedule ? { raw: extracted.schedule } : null,
        source_type: "user",
        confidence_score: 0.7,
        notes: reviewer_notes ?? null,
      })
      .select("id")
      .single();

    if (spotError) {
      return NextResponse.json({ error: spotError.message }, { status: 500 });
    }

    const { error: updateError } = await supabase
      .from("sign_submissions")
      .update({
        status: "approved",
        parking_spot_id: spot.id,
        reviewer_notes: reviewer_notes ?? null,
      })
      .eq("id", id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, parking_spot_id: spot.id });
  }

  return NextResponse.json({ error: "invalid action" }, { status: 400 });
}
