import { NextRequest, NextResponse } from "next/server";

import { ADMIN_AUTH_COOKIE, verifyAdminSessionToken } from "@/lib/admin-auth";

export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/admin/:path*"],
};

export async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (pathname === "/admin/login" || pathname === "/api/admin/auth") return NextResponse.next();

  const token = req.cookies.get(ADMIN_AUTH_COOKIE)?.value;
  if (await verifyAdminSessionToken(token)) return NextResponse.next();

  if (pathname.startsWith("/api/admin/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/admin/login";
  return NextResponse.redirect(loginUrl);
}
