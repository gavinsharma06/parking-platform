import { NextRequest, NextResponse } from "next/server";
import { getRateLimitMinute, getRateLimitDay } from "@/lib/ratelimit";
import { fetchFewShotExamples, buildPrompt } from "@/lib/training-examples";
import { extractParkingData, geminiErrorResponse, isGeminiConfigured } from "@/lib/gemini";

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
  if (!isGeminiConfigured()) {
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

  // ── Call Gemini (model, thinking level and timeout come from src/lib/gemini) ─
  try {
    return NextResponse.json(await extractParkingData(base64Data, prompt));
  } catch (err) {
    const { status, body } = geminiErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
