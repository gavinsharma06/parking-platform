import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import type { ExtractedParkingData } from "@/lib/parking-rules";
import { deriveParkingType } from "@/lib/parking-rules";

const PROMPT = `You are a parking sign parser. Analyze this parking sign image and extract all parking rules.

Return a JSON object matching this TypeScript type:

type RuleType = "paid" | "free" | "permit_only" | "accessible" | "no_parking" | "no_stopping" | "street_cleaning" | "tow_away";

type ParkingRule = {
  rule_type: RuleType;
  is_prohibited: boolean;
  days: number[] | null;          // null = all days; 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  time_window: { start: string; end: string } | null;  // HH:MM 24h format, null = 24/7
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  permit_zone: string | null;
  tow_away: boolean;
  raw_text: string;               // verbatim text from that sign panel
};

type ExtractedParkingData = {
  rules: ParkingRule[];
  raw_text: string;               // full raw OCR text of the entire image
  confidence: number;             // 0.0–1.0, your confidence in the extraction
  parking_type: "free" | "paid" | "permit" | "accessible" | "unknown";
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  schedule: string | null;        // e.g. "08:00–18:00" from the first rule, or null
};

Rules:
- Each distinct sign panel = one ParkingRule entry
- is_prohibited: true for no_parking, no_stopping, street_cleaning, tow_away; false for paid, free, permit_only, accessible
- If you see a wheelchair/accessibility symbol, set rule_type to "accessible"
- parking_type: derive from the highest-priority rule (accessible > permit > paid > free > unknown)
- time_limit_minutes: from the first rule that has a limit (e.g. "2 HR" = 120)
- cost_per_hour: from the first paid rule
- schedule: start–end from the first rule with a time window, e.g. "08:00–18:00", or null
- confidence: 0.9+ if times/days clearly visible, 0.5 if partial, 0.1 if unreadable

Respond with raw JSON only, no markdown, no code fences.`;

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not set. Add it to .env." },
      { status: 503 },
    );
  }

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

  const ai = new GoogleGenAI({ apiKey });

  // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  let rawJson: string;
  try {
    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        { inlineData: { mimeType: "image/jpeg", data: base64Data } },
        { text: PROMPT },
      ],
    });
    rawJson = (result.text ?? "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gemini API error: ${msg}` }, { status: 502 });
  }

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
