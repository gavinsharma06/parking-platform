import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { ExtractedParkingData } from "@/lib/parking-rules";
import { deriveParkingType } from "@/lib/parking-rules";
import { getRateLimitMinute, getRateLimitDay } from "@/lib/ratelimit";
import { fetchFewShotExamples, buildPrompt } from "@/lib/training-examples";

// ─── Helper: get best-effort client IP ───────────────────────────────────────

function getIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Rate limiting ──────────────────────────────────────────────────────────
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const ip = getIP(req);

    const [minResult, dayResult] = await Promise.all([
      getRateLimitMinute().limit(ip),
      getRateLimitDay().limit(ip),
    ]);

    if (!minResult.success) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a moment before trying again." },
        {
          status: 429,
          headers: {
            "Retry-After":           String(Math.ceil((minResult.reset - Date.now()) / 1000)),
            "X-RateLimit-Limit":     "10",
            "X-RateLimit-Remaining": String(minResult.remaining),
          },
        },
      );
    }

    if (!dayResult.success) {
      return NextResponse.json(
        { error: "Daily limit reached. You can analyse up to 50 signs per day." },
        {
          status: 429,
          headers: {
            "Retry-After":           String(Math.ceil((dayResult.reset - Date.now()) / 1000)),
            "X-RateLimit-Limit":     "50",
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  }

  // ── Gemini API key check ───────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set. Add it to .env." },
      { status: 503 },
    );
  }

  // ── Kick off few-shot fetch before awaiting the request body ───────────────
  // Supabase roundtrip (~50–150 ms) runs concurrently with JSON.parse so it
  // adds no wall-clock latency in the common case.
  const examplesPromise = fetchFewShotExamples(5);

  // ── Parse request body ─────────────────────────────────────────────────────
  let imageBase64: string;
  try {
    const body = await req.json();
    imageBase64 = body.image;
    if (!imageBase64) throw new Error("missing image field");
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON with an `image` field (base64 JPEG)." },
      { status: 400 },
    );
  }

  // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  // ── Build prompt with few-shot examples ────────────────────────────────────
  // Await here — almost certainly already resolved given body parsing above.
  // fetchFewShotExamples never throws, so no try/catch needed.
  const examples = await examplesPromise;
  const prompt = buildPrompt(examples);

  // ── Call Gemini Vision ─────────────────────────────────────────────────────
  const ai = new GoogleGenAI({ apiKey });

  let rawJson: string;
  try {
    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        { inlineData: { mimeType: "image/jpeg", data: base64Data } },
        { text: prompt },
      ],
      // Low thinking level — structured extraction doesn't need deep reasoning,
      // and this halves time-to-first-token vs the "high" default.
      config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
    });
    rawJson = (result.text ?? "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gemini API error: ${msg}` }, { status: 502 });
  }

  // ── Parse Gemini response ──────────────────────────────────────────────────
  let parsed: ExtractedParkingData;
  try {
    // Strip accidental markdown fences if model ignores instructions
    const clean = rawJson.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    parsed = JSON.parse(clean) as ExtractedParkingData;
  } catch {
    return NextResponse.json(
      { error: "Gemini returned unparseable JSON", raw: rawJson },
      { status: 500 },
    );
  }

  // Re-derive parking_type from rules as a sanity check
  parsed.parking_type = deriveParkingType(parsed.rules);

  return NextResponse.json(parsed);
}
