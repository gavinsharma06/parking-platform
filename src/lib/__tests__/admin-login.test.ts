import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// In-memory stand-in for Upstash, counting attempts per limiter + identifier.
const fake = vi.hoisted(() => ({
  configured: true,
  counts: new Map<string, number>(),
  limiters: [] as { name: string; max: number; window: string }[],
}));

vi.mock("@/lib/ratelimit", () => ({
  isRateLimitConfigured: () => fake.configured,
  getLimiter: (name: string, max: number, window: string) => {
    fake.limiters.push({ name, max, window });
    return {
      limit: async (identifier: string) => {
        const key = `${name}|${identifier}`;
        const used = (fake.counts.get(key) ?? 0) + 1;
        fake.counts.set(key, used);
        return { success: used <= max, limit: max, remaining: Math.max(0, max - used), reset: Date.now() + 60_000 };
      },
    };
  },
}));

import { POST } from "@/app/api/admin/auth/route";
import {
  ADMIN_AUTH_COOKIE,
  getAdminLoginLimit,
  isAdminSessionConfigured,
  verifyAdminPassword,
  verifyAdminSessionToken,
} from "../admin-auth";

const ENV_VARS = [
  "ADMIN_SESSION_SECRET",
  "ADMIN_GAVIN_PASSWORD",
  "ADMIN_ISHANT_PASSWORD",
  "ADMIN_LOGIN_MAX_ATTEMPTS",
  "ADMIN_LOGIN_WINDOW_MINUTES",
  "VERCEL_ENV",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.ADMIN_SESSION_SECRET = "test-session-secret";
  process.env.ADMIN_GAVIN_PASSWORD = "correct horse battery staple";

  fake.configured = true;
  fake.counts.clear();
  fake.limiters.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

function login(body: unknown, ip = "203.0.113.7"): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/admin/auth", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const GOOD = { username: "gavin", password: "correct horse battery staple" };

// ─── verifyAdminPassword ──────────────────────────────────────────────────────

describe("verifyAdminPassword", () => {
  it("accepts the right password", async () => {
    expect(await verifyAdminPassword("gavin", GOOD.password)).toBe(true);
  });

  it.each([
    ["a wrong password", "gavin", "wrong"],
    ["a password that is a prefix of the real one", "gavin", "correct horse"],
    ["an empty password", "gavin", ""],
    ["a non-string password", "gavin", 12345],
    ["an unknown user", "mallory", GOOD.password],
    ["an admin whose password is not configured", "ishant", ""],
  ])("rejects %s", async (_label, username, password) => {
    expect(await verifyAdminPassword(username, password)).toBe(false);
  });

  it("does not accept the placeholder used for unknown users", async () => {
    expect(await verifyAdminPassword("mallory", "unknown-admin-user")).toBe(false);
  });
});

// ─── POST /api/admin/auth ─────────────────────────────────────────────────────

describe("POST /api/admin/auth", () => {
  it("signs in with the right credentials and sets a verifiable session cookie", async () => {
    const res = await login({ username: "  Gavin ", password: GOOD.password });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, username: "gavin" });

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${ADMIN_AUTH_COOKIE}=`))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain(GOOD.password);

    const token = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
    expect(await verifyAdminSessionToken(token)).toEqual({ username: "gavin" });
  });

  it("returns the same 401 for a wrong password and an unknown user", async () => {
    const wrongPassword = await login({ username: "gavin", password: "nope" });
    const unknownUser = await login({ username: "mallory", password: "nope" });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownUser.json());
    expect(wrongPassword.headers.getSetCookie()).toHaveLength(0);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a JSON string", JSON.stringify("gavin")],
    ["a missing password", JSON.stringify({ username: "gavin" })],
    ["a non-string username", JSON.stringify({ username: 7, password: "x" })],
  ])("returns 400 for %s", async (_label, body) => {
    expect((await login(body)).status).toBe(400);
  });

  it("returns 429 on the 6th attempt in the window from one IP", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login({ username: "gavin", password: "nope" })).status).toBe(401);
    }

    const blocked = await login({ username: "gavin", password: "nope" });

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("blocks the right password too once the limit is reached", async () => {
    for (let i = 0; i < 5; i++) await login({ username: "gavin", password: "nope" });

    expect((await login(GOOD)).status).toBe(429);
  });

  it("counts attempts per IP", async () => {
    for (let i = 0; i < 6; i++) await login({ username: "gavin", password: "nope" }, "203.0.113.7");

    expect((await login(GOOD, "198.51.100.9")).status).toBe(200);
  });

  it("uses the configured attempt limit and window", async () => {
    process.env.ADMIN_LOGIN_MAX_ATTEMPTS = "2";
    process.env.ADMIN_LOGIN_WINDOW_MINUTES = "30";

    await login({ username: "gavin", password: "nope" });
    await login({ username: "gavin", password: "nope" });

    expect((await login(GOOD)).status).toBe(429);
    expect(fake.limiters[0]).toEqual({ name: "admin-login:attempts", max: 2, window: "30 m" });
  });

  it("fails closed in production when ADMIN_SESSION_SECRET is not set", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    process.env.VERCEL_ENV = "production";

    const res = await login(GOOD);

    expect(res.status).toBe(503);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("fails closed in production when the rate limiter is not configured", async () => {
    fake.configured = false;
    process.env.VERCEL_ENV = "production";

    expect((await login(GOOD)).status).toBe(503);
  });

  it("still allows sign-in locally without the rate limiter", async () => {
    fake.configured = false;

    expect((await login(GOOD)).status).toBe(200);
  });
});

// ─── Session secret and limits config ─────────────────────────────────────────

describe("session secret", () => {
  it("falls back to the passwords outside production", () => {
    delete process.env.ADMIN_SESSION_SECRET;
    expect(isAdminSessionConfigured()).toBe(true);
  });

  it("is required in production", () => {
    delete process.env.ADMIN_SESSION_SECRET;
    process.env.VERCEL_ENV = "production";
    expect(isAdminSessionConfigured()).toBe(false);
  });

  it("rejects an existing session in production once the secret is removed", async () => {
    const res = await login(GOOD);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${ADMIN_AUTH_COOKIE}=`))!;
    const token = decodeURIComponent(cookie.split(";")[0].split("=")[1]);

    delete process.env.ADMIN_SESSION_SECRET;
    process.env.VERCEL_ENV = "production";

    expect(await verifyAdminSessionToken(token)).toBeNull();
  });
});

describe("getAdminLoginLimit", () => {
  it("defaults to 5 attempts per 10 minutes", () => {
    expect(getAdminLoginLimit()).toEqual({ name: "attempts", max: 5, window: "10 m" });
  });

  it("ignores invalid overrides", () => {
    process.env.ADMIN_LOGIN_MAX_ATTEMPTS = "0";
    process.env.ADMIN_LOGIN_WINDOW_MINUTES = "soon";

    expect(getAdminLoginLimit()).toEqual({ name: "attempts", max: 5, window: "10 m" });
  });
});
