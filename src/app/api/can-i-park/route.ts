import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { generateAnswer } from "@/lib/parking-answer";
import { extractParkingData, geminiErrorResponse, isGeminiConfigured } from "@/lib/gemini";
import { isHalifaxLocation } from "@/lib/validation";
import { enforceAiRateLimit, readImageRequest } from "@/lib/ai-guard";
import type { ExtractedParkingData } from "@/lib/parking-rules";

const PROMPT = `You are a parking sign parser. Analyze this parking sign image and extract all parking rules.

Return a JSON object matching this TypeScript type:

type RuleType = "paid" | "free" | "permit_only" | "accessible" | "no_parking" | "no_stopping" | "street_cleaning" | "tow_away";

type ParkingRule = {
  rule_type: RuleType;
  is_prohibited: boolean;
  days: number[] | null;
  time_window: { start: string; end: string } | null;
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  permit_zone: string | null;
  tow_away: boolean;
  direction: "left" | "right" | "both" | null;
  raw_text: string;
};

type ExtractedParkingData = {
  rules: ParkingRule[];
  raw_text: string;
  confidence: number;
  parking_type: "free" | "paid" | "permit" | "accessible" | "unknown";
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  schedule: string | null;
};

Rules:
- Each distinct sign panel = one ParkingRule entry
- is_prohibited: true for no_parking, no_stopping, street_cleaning, tow_away
- parking_type: derive from highest-priority rule (accessible > permit > paid > free > unknown)
- time_limit_minutes: from the first rule that has a limit
- cost_per_hour: from the first paid rule
- schedule: start–end from the first rule with a time window, or null
- confidence: 0.9+ if clearly readable, 0.5 if partial, 0.1 if unreadable
- direction: "left" / "right" / "both" / null based on arrow symbols

Respond with raw JSON only, no markdown, no code fences.`;

// ─── Handler ──────────────────────────────────────────────────────────────────

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

  // ── Call Gemini (model, thinking level and timeout come from src/lib/gemini) ─
  let parsed: ExtractedParkingData;
  try {
    parsed = await extractParkingData(base64Data, PROMPT);
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
      // Non-fatal — user still gets their answer
    }
  }

  return NextResponse.json({ answer, can_park, rules: parsed.rules, confidence: parsed.confidence });
}
