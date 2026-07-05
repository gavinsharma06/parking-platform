import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-route-guard";
import { createServiceRoleClient } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const supabase = createServiceRoleClient();

  const { data: submissions, error } = await supabase
    .from("sign_submissions")
    .select("*")
    .order("submitted_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const withUrls = await Promise.all(
    (submissions ?? []).map(async (sub) => {
      const { data: urlData } = await supabase.storage
        .from("parking-signs")
        .createSignedUrl(sub.image_path, 3600);
      return { ...sub, image_url: urlData?.signedUrl ?? null };
    }),
  );

  return NextResponse.json(withUrls);
}
