import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { extractParkingData, geminiErrorResponse, isGeminiConfigured } from "@/lib/gemini";
import { generateAnswer } from "@/lib/parking-answer";
import { buildPrompt, fetchFewShotExamples } from "@/lib/training-examples";
import { isHalifaxLocation } from "@/lib/validation";
import { enforceAiRateLimit, readImageRequest } from "@/lib/ai-guard";
import type { ExtractedParkingData } from "@/lib/parking-rules";

export async function POST(req: NextRequest) {
  // ── Rate limiting (before the body is read or any AI call is made) ─────────
  const limited = await enforceAiRateLimit(req, "can-i-park");
  if (limited) return limited;

  if (!isGeminiConfigured()) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set." }, { status: 503 });
  }

  // ── Parse request body (size-capped; data URI prefix stripped) ─────────────
  const payload = await readImageRequest(req);
  if (!payload.ok) return payload.response;

  const base64Data = payload.imageBase64;
  const { latitude: lat, longitude: lng } = payload.body;
  const latitude  = typeof lat === "number" && Number.isFinite(lat) ? lat : null;
  const longitude = typeof lng === "number" && Number.isFinite(lng) ? lng : null;

  let parsed: ExtractedParkingData;
  try {
    const examples = await fetchFewShotExamples(5);
    parsed = await extractParkingData(base64Data, buildPrompt(examples));
  } catch (err) {
    const { status, body } = geminiErrorResponse(err);
    return NextResponse.json(body, { status });
  }

  // ── Plain-language answer ──────────────────────────────────────────────────
  const { answer, can_park } = generateAnswer(parsed.rules, new Date());

  // ── Save to sign_submissions (same pipeline as manual submit) ──────────────
  // Only if we have a valid Halifax location
  if (latitude !== null && longitude !== null && isHalifaxLocation(latitude, longitude)) {
    try {
      const supabase = createServiceRoleClient();
      const storagePath = `submissions/${Date.now()}-${crypto.randomUUID()}.jpg`;
      const buffer = Buffer.from(base64Data, "base64");

      const { error: storageErr } = await supabase.storage
        .from("parking-signs")
        .upload(storagePath, buffer, { contentType: "image/jpeg", upsert: false });

      if (!storageErr) {
        await supabase.from("sign_submissions").insert({
          image_path:      storagePath,
          latitude,
          longitude,
          device_metadata: { source: "quick_check", capturedAt: new Date().toISOString() },
          extracted_data:  parsed,
        });
      }
    } catch {
      // Non-fatal - user still gets their answer
    }
  }

  return NextResponse.json({ answer, can_park, rules: parsed.rules, confidence: parsed.confidence });
}
