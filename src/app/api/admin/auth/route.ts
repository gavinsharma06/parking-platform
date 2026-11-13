import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_AUTH_COOKIE,
  ADMIN_USER_COOKIE,
  createAdminSessionToken,
  getAdminLoginLimit,
  getAdminSessionCookieOptions,
  getAdminUserCookieOptions,
  isAdminSessionConfigured,
  normalizeAdminUsername,
  verifyAdminPassword,
} from "@/lib/admin-auth";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit-guard";
import { getClientIp } from "@/lib/request";

const INVALID_CREDENTIALS = "Incorrect username or password.";

// POST /api/admin/auth — sign in
export async function POST(req: NextRequest) {
  // ── Limit attempts per IP before looking at the credentials ────────────────
  const outcome = await checkRateLimit("admin-login", `ip:${getClientIp(req.headers)}`, [
    getAdminLoginLimit(),
  ]);

  if (outcome.status === "unavailable") {
    return NextResponse.json(
      { error: "Sign-in is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  }
  if (outcome.status === "limited") {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please wait before trying again." },
      { status: 429, headers: rateLimitHeaders(outcome) },
    );
  }

  // ── Refuse to sign anyone in if sessions cannot be signed safely ───────────
  if (!isAdminSessionConfigured()) {
    console.error("[admin-auth] ADMIN_SESSION_SECRET is not set; sign-in is disabled.");
    return NextResponse.json({ error: "Admin sign-in is not configured." }, { status: 503 });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let username: unknown;
  let password: unknown;
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    ({ username, password } = body as { username?: unknown; password?: unknown });
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON with `username` and `password`." },
      { status: 400 },
    );
  }

  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json(
      { error: "Body must be JSON with `username` and `password`." },
      { status: 400 },
    );
  }

  // ── Check credentials (same response for a wrong user or a wrong password) ──
  const key = normalizeAdminUsername(username);
  if (!(await verifyAdminPassword(key, password))) {
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  const token = await createAdminSessionToken(key);
  const res = NextResponse.json({ ok: true, username: key });
  res.cookies.set(ADMIN_AUTH_COOKIE, token, getAdminSessionCookieOptions());
  res.cookies.set(ADMIN_USER_COOKIE, key, getAdminUserCookieOptions());
  return res;
}

// DELETE /api/admin/auth — sign out
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_AUTH_COOKIE, "", { maxAge: 0, path: "/" });
  res.cookies.set(ADMIN_USER_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
