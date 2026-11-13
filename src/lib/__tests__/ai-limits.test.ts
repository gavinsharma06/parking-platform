import { afterEach, describe, expect, it } from "vitest";

import {
  base64DecodedBytes,
  getAiLimits,
  isJpegBase64,
  selectRateTier,
  stripDataUriPrefix,
} from "../ai-limits";

const LIMIT_ENV_VARS = [
  "AI_RATE_LIMIT_PER_MINUTE",
  "AI_RATE_LIMIT_PER_DAY",
  "AI_ADMIN_RATE_LIMIT_PER_MINUTE",
  "AI_ADMIN_RATE_LIMIT_PER_DAY",
  "AI_MAX_BODY_BYTES",
  "AI_MAX_IMAGE_BYTES",
];

afterEach(() => {
  for (const name of LIMIT_ENV_VARS) delete process.env[name];
});

function maxOf(windows: { name: string; max: number }[], name: string): number | undefined {
  return windows.find((w) => w.name === name)?.max;
}

// ─── getAiLimits ──────────────────────────────────────────────────────────────

describe("getAiLimits", () => {
  it("uses the documented defaults when no env vars are set", () => {
    const limits = getAiLimits();

    expect(maxOf(limits.public, "minute")).toBe(10);
    expect(maxOf(limits.public, "day")).toBe(50);
    expect(maxOf(limits.admin, "minute")).toBe(60);
    expect(maxOf(limits.admin, "day")).toBe(500);
    expect(limits.maxBodyBytes).toBe(4 * 1024 * 1024);
    expect(limits.maxImageBytes).toBe(3 * 1024 * 1024);
  });

  it("reads overrides from the environment", () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = "3";
    process.env.AI_MAX_IMAGE_BYTES = "1000";

    const limits = getAiLimits();

    expect(maxOf(limits.public, "minute")).toBe(3);
    expect(limits.maxImageBytes).toBe(1000);
  });

  it("falls back to the default for invalid overrides", () => {
    process.env.AI_RATE_LIMIT_PER_MINUTE = "abc";
    process.env.AI_RATE_LIMIT_PER_DAY = "0";
    process.env.AI_MAX_BODY_BYTES = "-5";

    const limits = getAiLimits();

    expect(maxOf(limits.public, "minute")).toBe(10);
    expect(maxOf(limits.public, "day")).toBe(50);
    expect(limits.maxBodyBytes).toBe(4 * 1024 * 1024);
  });
});

// ─── selectRateTier ───────────────────────────────────────────────────────────

describe("selectRateTier", () => {
  it("uses the public limits keyed by IP for anonymous requests", () => {
    const tier = selectRateTier(null, "203.0.113.7");

    expect(tier.tier).toBe("public");
    expect(tier.identifier).toBe("ip:203.0.113.7");
    expect(maxOf(tier.windows, "minute")).toBe(10);
    expect(maxOf(tier.windows, "day")).toBe(50);
  });

  it("uses the admin limits keyed by username for a logged-in admin", () => {
    const tier = selectRateTier("gavin", "203.0.113.7");

    expect(tier.tier).toBe("admin");
    expect(tier.identifier).toBe("admin:gavin");
    expect(maxOf(tier.windows, "minute")).toBe(60);
    expect(maxOf(tier.windows, "day")).toBe(500);
  });

  it("gives two admins on the same IP separate buckets", () => {
    const a = selectRateTier("gavin", "203.0.113.7");
    const b = selectRateTier("ishant", "203.0.113.7");

    expect(a.identifier).not.toBe(b.identifier);
  });

  it("never lets an admin bucket collide with an IP bucket", () => {
    const admin = selectRateTier("203.0.113.7", "198.51.100.1");
    const anon  = selectRateTier(null, "203.0.113.7");

    expect(admin.identifier).not.toBe(anon.identifier);
  });
});

// ─── Image payload helpers ────────────────────────────────────────────────────

describe("stripDataUriPrefix", () => {
  it("removes a data URI prefix", () => {
    expect(stripDataUriPrefix("data:image/jpeg;base64,/9j/abc")).toBe("/9j/abc");
  });

  it("leaves bare base64 untouched", () => {
    expect(stripDataUriPrefix("/9j/abc")).toBe("/9j/abc");
  });
});

describe("base64DecodedBytes", () => {
  it.each([0, 1, 2, 3, 4, 5, 1000, 4097])("matches the real decoded size for %i bytes", (size) => {
    const base64 = Buffer.alloc(size, 7).toString("base64");
    expect(base64DecodedBytes(base64)).toBe(size);
  });
});

describe("isJpegBase64", () => {
  it("accepts base64 that starts with the JPEG magic bytes", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");
    expect(isJpegBase64(jpeg)).toBe(true);
  });

  it("rejects a PNG", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64");
    expect(isJpegBase64(png)).toBe(false);
  });

  it("rejects arbitrary text", () => {
    expect(isJpegBase64(Buffer.from("hello world").toString("base64"))).toBe(false);
  });
});
