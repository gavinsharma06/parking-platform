import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { ExtractedParkingData } from "@/lib/parking-rules";
import { deriveParkingType } from "@/lib/parking-rules";
import { enforceAiRateLimit, readImageRequest } from "@/lib/ai-guard";
import { fetchFewShotExamples, buildPrompt } from "@/lib/training-examples";

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Rate limiting (before the body is read or any AI call is made) ─────────
  const limited = await enforceAiRateLimit(req, "analyse");
  if (limited) return limited;

  // ── Gemini API key check ───────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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
  const base64Data = payload.imageBase64;

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
