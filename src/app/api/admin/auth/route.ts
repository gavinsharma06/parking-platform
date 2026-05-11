import { NextRequest, NextResponse } from "next/server";

const ADMINS: Record<string, string | undefined> = {
  gavin:  process.env.ADMIN_GAVIN_PASSWORD,
  ishant: process.env.ADMIN_ISHANT_PASSWORD,
};

const BASE = {
  secure:   process.env.NODE_ENV === "production",
  maxAge:   60 * 60 * 24 * 7,
  path:     "/",
  sameSite: "lax" as const,
};

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  const key = (username ?? "").toLowerCase().trim();
  const expected = ADMINS[key];

  if (!expected || password !== expected) {
    return NextResponse.json({ error: "Incorrect username or password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, username: key });
  res.cookies.set("admin_auth", `${key}:${password}`, { ...BASE, httpOnly: true });
  res.cookies.set("admin_user", key, { ...BASE, httpOnly: false });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("admin_auth", "", { maxAge: 0, path: "/" });
  res.cookies.set("admin_user", "", { maxAge: 0, path: "/" });
  return res;
}
