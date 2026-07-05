import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_AUTH_COOKIE, verifyAdminSessionToken } from "@/lib/admin-auth";

export async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  const token = req.cookies.get(ADMIN_AUTH_COOKIE)?.value;
  const session = await verifyAdminSessionToken(token);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
