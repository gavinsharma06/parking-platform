import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { enforceAiRateLimit, readImageRequest } from "../ai-guard";

const ENV_VARS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL_ENV",
  "AI_MAX_BODY_BYTES",
  "AI_MAX_IMAGE_BYTES",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

function post(body: string): NextRequest {
  return new NextRequest("http://localhost/api/can-i-park", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Base64 of a buffer that starts with the JPEG magic bytes. */
function jpegBase64(bytes: number): string {
  const buffer = Buffer.alloc(bytes, 1);
  buffer.set([0xff, 0xd8, 0xff], 0);
  return buffer.toString("base64");
}

// ─── readImageRequest ─────────────────────────────────────────────────────────

describe("readImageRequest", () => {
  it("accepts a small JPEG and returns the other body fields", async () => {
    const image = jpegBase64(2_000);
    const result = await readImageRequest(post(JSON.stringify({ image, latitude: 44.65 })));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imageBase64).toBe(image);
      expect(result.body.latitude).toBe(44.65);
    }
  });

  it("strips a data URI prefix", async () => {
    const image = jpegBase64(2_000);
    const result = await readImageRequest(
      post(JSON.stringify({ image: `data:image/jpeg;base64,${image}` })),
    );

    expect(result.ok && result.imageBase64).toBe(image);
  });

  it("returns 413 for a 6 MB payload", async () => {
    const result = await readImageRequest(
      post(JSON.stringify({ image: jpegBase64(6 * 1024 * 1024) })),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      expect(await result.response.json()).toEqual({ error: "Image too large" });
    }
  });

  it("returns 413 when the body fits but the decoded image exceeds the image cap", async () => {
    process.env.AI_MAX_IMAGE_BYTES = "1000";

    const result = await readImageRequest(post(JSON.stringify({ image: jpegBase64(5_000) })));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("returns 400 for a non-JPEG image", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const result = await readImageRequest(post(JSON.stringify({ image: png })));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a missing image field", JSON.stringify({ latitude: 1 })],
    ["a non-string image", JSON.stringify({ image: 42 })],
    ["an array body", JSON.stringify(["x"])],
  ])("returns 400 for %s", async (_label, body) => {
    const result = await readImageRequest(post(body));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});

// ─── enforceAiRateLimit: behaviour when Upstash is not configured ─────────────

describe("enforceAiRateLimit without Upstash config", () => {
  it("allows the request outside production", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await enforceAiRateLimit(post("{}"), "can-i-park")).toBeNull();
  });

  it("fails closed with 503 in production", async () => {
    process.env.VERCEL_ENV = "production";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await enforceAiRateLimit(post("{}"), "can-i-park");

    expect(response?.status).toBe(503);
  });

  it("allows the request on a Vercel preview deployment", async () => {
    process.env.VERCEL_ENV = "preview";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await enforceAiRateLimit(post("{}"), "can-i-park")).toBeNull();
  });
});
