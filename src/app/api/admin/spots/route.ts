import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase-server";

// GET /api/admin/spots — list all parking spots
export async function GET() {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("parking_spots")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

// POST /api/admin/spots — manually create a spot
export async function POST(req: NextRequest) {
  const supabase = createServiceRoleClient();
  const body = await req.json();

  const { data, error } = await supabase
    .from("parking_spots")
    .insert({
      latitude: body.latitude,
      longitude: body.longitude,
      parking_type: body.parking_type ?? "unknown",
      street_name: body.street_name ?? null,
      from_street: body.from_street ?? null,
      to_street: body.to_street ?? null,
      time_limit_minutes: body.time_limit_minutes ?? null,
      cost_per_hour: body.cost_per_hour ?? null,
      notes: body.notes ?? null,
      source_type: "manual",
      confidence_score: 1.0,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}
