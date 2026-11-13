import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// In-memory stand-in for Upstash: counts calls per limiter name + identifier
// and reports failure once `max` is exceeded, like a real fixed window.
const fake = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as { name: string; max: number; identifier: string }[],
  throwOnLimit: false,
}));

vi.mock("../ratelimit", () => ({
  isRateLimitConfigured: () => true,
  getLimiter: (name: string, max: number) => ({
    limit: async (identifier: string) => {
      if (fake.throwOnLimit) throw new Error("fetch failed");

      fake.calls.push({ name, max, identifier });
      const key = `${name}|${identifier}`;
      const used = (fake.counts.get(key) ?? 0) + 1;
      fake.counts.set(key, used);

      return {
        success:   used <= max,
        limit:     max,
        remaining: Math.max(0, max - used),
        reset:     Date.now() + 30_000,
      };
    },
  }),
}));

import { ADMIN_AUTH_COOKIE, createAdminSessionToken } from "../admin-auth";
import { enforceAiRateLimit } from "../ai-guard";

const ENV_VARS = ["VERCEL_ENV", "ADMIN_SESSION_SECRET", "ADMIN_GAVIN_PASSWORD"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  fake.counts.clear();
  fake.calls.length = 0;
  fake.throwOnLimit = false;
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

function request(ip: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://localhost/api/can-i-park", { method: "POST", headers });
}

async function adminCookie(): Promise<string> {
  process.env.ADMIN_SESSION_SECRET = "test-secret";
  process.env.ADMIN_GAVIN_PASSWORD = "test-password";
  return `${ADMIN_AUTH_COOKIE}=${await createAdminSessionToken("gavin")}`;
}

describe("enforceAiRateLimit", () => {
  it("returns 429 with Retry-After on the 11th request in a minute from one IP", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await enforceAiRateLimit(request("203.0.113.7"), "can-i-park")).toBeNull();
    }

    const blocked = await enforceAiRateLimit(request("203.0.113.7"), "can-i-park");

    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked?.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(blocked?.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("does not spend the daily allowance on a request blocked by the minute limit", async () => {
    for (let i = 0; i < 11; i++) await enforceAiRateLimit(request("203.0.113.7"), "can-i-park");

    const dayCalls = fake.calls.filter((c) => c.name.endsWith(":day"));
    expect(dayCalls).toHaveLength(10);
  });

  it("counts each IP separately", async () => {
    for (let i = 0; i < 10; i++) await enforceAiRateLimit(request("203.0.113.7"), "can-i-park");

    expect(await enforceAiRateLimit(request("198.51.100.9"), "can-i-park")).toBeNull();
  });

  it("counts each route separately", async () => {
    for (let i = 0; i < 10; i++) await enforceAiRateLimit(request("203.0.113.7"), "can-i-park");

    expect(await enforceAiRateLimit(request("203.0.113.7"), "analyse")).toBeNull();
  });

  it("lets a logged-in admin make 30 requests in a minute", async () => {
    const cookie = await adminCookie();

    for (let i = 0; i < 30; i++) {
      expect(await enforceAiRateLimit(request("203.0.113.7", cookie), "can-i-park")).toBeNull();
    }
    expect(fake.calls.every((c) => c.identifier === "admin:gavin")).toBe(true);
  });

  it("treats an invalid admin cookie as a public request", async () => {
    await adminCookie();
    const forged = `${ADMIN_AUTH_COOKIE}=not-a-real-token`;

    await enforceAiRateLimit(request("203.0.113.7", forged), "can-i-park");

    expect(fake.calls[0].identifier).toBe("ip:203.0.113.7");
    expect(fake.calls[0].max).toBe(10);
  });

  it("fails closed with 503 in production when the limiter cannot be reached", async () => {
    process.env.VERCEL_ENV = "production";
    fake.throwOnLimit = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await enforceAiRateLimit(request("203.0.113.7"), "can-i-park");

    expect(response?.status).toBe(503);
  });

  it("allows the request outside production when the limiter cannot be reached", async () => {
    fake.throwOnLimit = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await enforceAiRateLimit(request("203.0.113.7"), "can-i-park")).toBeNull();
  });
});
