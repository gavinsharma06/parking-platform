import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Everything that costs money or writes data is replaced, so the tests can
// assert exactly which gates let a request through to the AI call and storage.
const calls = vi.hoisted(() => ({
  extract: [] as string[],
  saved: [] as Record<string, unknown>[],
  extractError: null as Error | null,
  saveError: null as Error | null,
}));

const EXTRACTED = vi.hoisted(() => ({
  rules: [
    {
      rule_type: "paid",
      is_prohibited: false,
      days: null,
      time_window: null,
      time_limit_minutes: null,
      cost_per_hour: null,
      permit_zone: null,
      tow_away: false,
      direction: null,
      raw_text: "PAY ZONE",
    },
  ],
  raw_text: "PAY ZONE",
  confidence: 0.9,
  parking_type: "paid",
  time_limit_minutes: null,
  cost_per_hour: null,
  schedule: null,
}));

vi.mock("@/lib/ratelimit", () => ({
  isRateLimitConfigured: () => false, // outside production this means "allow"
  getLimiter: () => {
    throw new Error("limiter should not be used in these tests");
  },
}));

vi.mock("@/lib/gemini", () => ({
  SIGN_IMAGE_MIME_TYPE: "image/jpeg",
  isGeminiConfigured: () => true,
  extractParkingData: async (image: string) => {
    calls.extract.push(image);
    if (calls.extractError) throw calls.extractError;
    return EXTRACTED;
  },
  geminiErrorResponse: () => ({ status: 502, body: { error: "Gemini API error: boom" } }),
}));

vi.mock("@/lib/training-examples", () => ({
  fetchFewShotExamples: async () => [],
  buildPrompt: () => "prompt",
}));

vi.mock("@/lib/sign-submissions", () => ({
  saveSignSubmission: async (input: Record<string, unknown>) => {
    if (calls.saveError) throw calls.saveError;
    calls.saved.push(input);
    return { id: "submission-1" };
  },
}));

import { POST as submit } from "@/app/api/submissions/route";
import { POST as canIPark } from "@/app/api/can-i-park/route";

const HALIFAX = { latitude: 44.6476, longitude: -63.5788 };
const TORONTO = { latitude: 43.6532, longitude: -79.3832 };

const JPEG = (() => {
  const buffer = Buffer.alloc(2_000, 1);
  buffer.set([0xff, 0xd8, 0xff], 0);
  return buffer.toString("base64");
})();

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest-agent" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  calls.extract.length = 0;
  calls.saved.length = 0;
  calls.extractError = null;
  calls.saveError = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── POST /api/submissions ────────────────────────────────────────────────────

describe("POST /api/submissions", () => {
  it("reads the sign, stores the submission and returns the rules", async () => {
    const res = await submit(post("/api/submissions", { image: JPEG, ...HALIFAX }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "submission-1", extracted_data: EXTRACTED });
    expect(calls.extract).toHaveLength(1);
    expect(calls.saved[0]).toMatchObject({
      imageBase64: JPEG,
      coordinates: HALIFAX,
      source: "submit",
      userAgent: "vitest-agent",
      extractedData: EXTRACTED,
    });
  });

  it("rejects a location outside Halifax without calling the AI model or storage", async () => {
    const res = await submit(post("/api/submissions", { image: JPEG, ...TORONTO }));

    expect(res.status).toBe(422);
    expect(calls.extract).toHaveLength(0);
    expect(calls.saved).toHaveLength(0);
  });

  it.each([
    ["missing coordinates", { image: JPEG }],
    ["string coordinates", { image: JPEG, latitude: "44.6", longitude: "-63.5" }],
    ["an impossible latitude", { image: JPEG, latitude: 144, longitude: -63.5 }],
    ["a non-finite longitude", { image: JPEG, latitude: 44.6, longitude: null }],
  ])("returns 400 for %s without calling the AI model or storage", async (_label, body) => {
    const res = await submit(post("/api/submissions", body));

    expect(res.status).toBe(400);
    expect(calls.extract).toHaveLength(0);
    expect(calls.saved).toHaveLength(0);
  });

  it("rejects a non-JPEG payload without calling the AI model or storage", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

    const res = await submit(post("/api/submissions", { image: png, ...HALIFAX }));

    expect(res.status).toBe(400);
    expect(calls.extract).toHaveLength(0);
    expect(calls.saved).toHaveLength(0);
  });

  it("rejects an oversized image without calling the AI model or storage", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    big.set([0xff, 0xd8, 0xff], 0);

    const res = await submit(post("/api/submissions", { image: big.toString("base64"), ...HALIFAX }));

    expect(res.status).toBe(413);
    expect(calls.extract).toHaveLength(0);
    expect(calls.saved).toHaveLength(0);
  });

  it("ignores rules and metadata supplied by the client", async () => {
    await submit(
      post("/api/submissions", {
        image: JPEG,
        ...HALIFAX,
        extracted_data: { rules: [{ rule_type: "free" }] },
        device_metadata: { anything: "x".repeat(1000) },
        status: "approved",
      }),
    );

    expect(calls.saved[0].extractedData).toEqual(EXTRACTED);
    expect(Object.keys(calls.saved[0]).sort()).toEqual(
      ["coordinates", "extractedData", "imageBase64", "source", "userAgent"],
    );
  });

  it("still stores the photo for manual review when the sign cannot be read", async () => {
    calls.extractError = new Error("model unavailable");

    const res = await submit(post("/api/submissions", { image: JPEG, ...HALIFAX }));

    expect(res.status).toBe(201);
    expect((await res.json()).extracted_data).toBeNull();
    expect(calls.saved[0].extractedData).toBeNull();
  });

  it("returns 500 without leaking details when storage fails", async () => {
    calls.saveError = new Error("Image upload failed: bucket secret detail");

    const res = await submit(post("/api/submissions", { image: JPEG, ...HALIFAX }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });
});

// ─── POST /api/can-i-park ─────────────────────────────────────────────────────

describe("POST /api/can-i-park", () => {
  it("answers and stores the photo when the location is in Halifax", async () => {
    const res = await canIPark(post("/api/can-i-park", { image: JPEG, ...HALIFAX }));

    expect(res.status).toBe(200);
    expect(calls.extract).toHaveLength(1);
    expect(calls.saved[0]).toMatchObject({ source: "quick_check", coordinates: HALIFAX });
  });

  it("answers without storing anything when no location is sent", async () => {
    const res = await canIPark(post("/api/can-i-park", { image: JPEG }));

    expect(res.status).toBe(200);
    expect(calls.extract).toHaveLength(1);
    expect(calls.saved).toHaveLength(0);
  });

  it("rejects a location outside Halifax without calling the AI model or storage", async () => {
    const res = await canIPark(post("/api/can-i-park", { image: JPEG, ...TORONTO }));

    expect(res.status).toBe(422);
    expect(calls.extract).toHaveLength(0);
    expect(calls.saved).toHaveLength(0);
  });

  it("still answers when saving the photo fails", async () => {
    calls.saveError = new Error("storage down");

    const res = await canIPark(post("/api/can-i-park", { image: JPEG, ...HALIFAX }));

    expect(res.status).toBe(200);
    expect((await res.json()).can_park).toBe(true);
  });
});
