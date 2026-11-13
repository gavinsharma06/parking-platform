import { NextRequest, NextResponse } from "next/server";

import { isAuthorizedCron } from "@/lib/cron-auth";
import { createServiceRoleClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.from("parking_spots").select("id").limit(1);
    if (error) throw error;
  } catch {
    console.error("Health check database query failed");
    return NextResponse.json({ ok: false, error: "db_unreachable" }, { status: 503 });
  }

  return NextResponse.json({ ok: true, db: "up", checkedAt: new Date().toISOString() });
}
