import { NextRequest, NextResponse } from "next/server";
import { enforceAiRateLimit, readImageRequest } from "@/lib/ai-guard";
import { fetchFewShotExamples, buildPrompt } from "@/lib/training-examples";
import { extractParkingData, geminiErrorResponse, isGeminiConfigured } from "@/lib/gemini";

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Rate limiting (before the body is read or any AI call is made) ─────────
  const limited = await enforceAiRateLimit(req, "analyse");
  if (limited) return limited;

  // ── Gemini API key check ───────────────────────────────────────────────────
  if (!isGeminiConfigured()) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set. Add it to .env." },
      { status: 503 },
    );
  }

  // ── Kick off few-shot fetch before awaiting the request body ───────────────
  // Supabase roundtrip (~50–150 ms) runs concurrently with body parsing so it
  // adds no wall-clock latency in the common case.
  const examplesPromise = fetchFewShotExamples(5);

  // ── Parse request body (size-capped; data URI prefix stripped) ─────────────
  const payload = await readImageRequest(req);
  if (!payload.ok) return payload.response;

  // ── Build prompt with few-shot examples ────────────────────────────────────
  // fetchFewShotExamples never throws, so no try/catch needed.
  const prompt = buildPrompt(await examplesPromise);

  // ── Call Gemini (model, thinking level and timeout come from src/lib/gemini) ─
  try {
    return NextResponse.json(await extractParkingData(payload.imageBase64, prompt));
  } catch (err) {
    const { status, body } = geminiErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
