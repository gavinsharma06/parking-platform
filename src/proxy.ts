import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};

const ADMINS: Record<string, string | undefined> = {
  gavin:  process.env.ADMIN_GAVIN_PASSWORD,
  ishant: process.env.ADMIN_ISHANT_PASSWORD,
};

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === "/admin/login") return NextResponse.next();

  const cookie = req.cookies.get("admin_auth")?.value ?? "";
  const colonIdx = cookie.indexOf(":");
  const username = cookie.slice(0, colonIdx);
  const password = cookie.slice(colonIdx + 1);
  const expected = ADMINS[username];

  if (expected && password === expected) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/admin/login";
  return NextResponse.redirect(loginUrl);
}
