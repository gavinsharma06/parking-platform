import { NextRequest, NextResponse } from "next/server";
import { generateAnswer } from "@/lib/parking-answer";
import { extractParkingData, geminiErrorResponse, isGeminiConfigured } from "@/lib/gemini";
import { isHalifaxLocation, OUTSIDE_SERVICE_AREA_MESSAGE, parseCoordinates } from "@/lib/validation";
import { saveSignSubmission } from "@/lib/sign-submissions";
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

  // ── Location is optional, but if sent it must be inside the service area ───
  // Checked before the AI call so out-of-area requests cost nothing.
  const coords = parseCoordinates(payload.body.latitude, payload.body.longitude);
  if (coords && !isHalifaxLocation(coords.latitude, coords.longitude)) {
    return NextResponse.json({ error: OUTSIDE_SERVICE_AREA_MESSAGE }, { status: 422 });
  }

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
  // Only when a location was sent. Non-fatal: the user still gets their answer.
  if (coords) {
    try {
      await saveSignSubmission({
        imageBase64:   base64Data,
        coordinates:   coords,
        source:        "quick_check",
        userAgent:     req.headers.get("user-agent"),
        extractedData: parsed,
      });
    } catch (err) {
      console.error("[can-i-park] could not save submission:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ answer, can_park, rules: parsed.rules, confidence: parsed.confidence });
}
