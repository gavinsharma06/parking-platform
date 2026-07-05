import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_AUTH_COOKIE,
  ADMIN_USER_COOKIE,
  createAdminSessionToken,
  getAdminPassword,
  getAdminSessionCookieOptions,
  getAdminUserCookieOptions,
  normalizeAdminUsername,
} from "@/lib/admin-auth";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const key = normalizeAdminUsername(username);
  const expected = getAdminPassword(key);

  if (!expected || password !== expected) {
    return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
  }

  const token = await createAdminSessionToken(key);
  const res = NextResponse.json({ ok: true, username: key });
  res.cookies.set(ADMIN_AUTH_COOKIE, token, getAdminSessionCookieOptions());
  res.cookies.set(ADMIN_USER_COOKIE, key, getAdminUserCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_AUTH_COOKIE, "", { maxAge: 0, path: "/" });
  res.cookies.set(ADMIN_USER_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
