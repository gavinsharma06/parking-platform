import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { evaluateSpot, formatTime, deriveParkingType } from "@/lib/parking-rules";
import { isHalifaxLocation } from "@/lib/validation";
import type { ExtractedParkingData, ParkingRule } from "@/lib/parking-rules";

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

// ─── Plain-language answer ────────────────────────────────────────────────────

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function formatLimit(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h > 0 ? `${h}h` : ""}${m > 0 ? ` ${m}m` : ""}`.trim();
}

function generateAnswer(rules: ParkingRule[], now: Date): { answer: string; can_park: boolean | null } {
  const status = evaluateSpot(rules, now);
  const day = now.getDay();
  const minutesNow = now.getHours() * 60 + now.getMinutes();

  let nextRestrictionAt: string | null = null;
  for (const rule of rules) {
    if (!rule.is_prohibited || !rule.time_window) continue;
    if (rule.days !== null && !rule.days.includes(day)) continue;
    const start = toMinutes(rule.time_window.start);
    if (start > minutesNow) {
      if (!nextRestrictionAt || start < toMinutes(nextRestrictionAt)) {
        nextRestrictionAt = rule.time_window.start;
      }
    }
  }

  switch (status.status) {
    case "no_stopping":
      return { answer: "No — tow-away zone in effect. Do not stop here.", can_park: false };

    case "no_parking": {
      const active = status.activeRules.find((r) => r.is_prohibited && r.time_window);
      if (active?.time_window) {
        return {
          answer: `No — no parking right now. Restriction lifts at ${formatTime(active.time_window.end)}.`,
          can_park: false,
        };
      }
      return { answer: "No — no parking allowed here.", can_park: false };
    }

    case "paid": {
      const paid = status.activeRules.find((r) => r.rule_type === "paid");
      const limit = paid?.time_limit_minutes;
      const end = paid?.time_window?.end;
      let answer = "Yes — paid parking.";
      if (limit) answer = `Yes — paid parking, ${formatLimit(limit)} maximum.`;
      if (end) answer += ` Meters enforced until ${formatTime(end)}.`;
      return { answer, can_park: true };
    }

    case "permit":
      return { answer: "No — permit zone. A residential parking permit is required.", can_park: false };

    case "accessible":
      return { answer: "No — accessible parking only. A valid accessibility permit is required.", can_park: false };

    case "free": {
      const limitRule = rules.find((r) => r.time_limit_minutes && !r.is_prohibited);
      const timeLimit = limitRule?.time_limit_minutes;
      let answer = "Yes — free to park here.";
      if (timeLimit) answer = `Yes — free parking, ${formatLimit(timeLimit)} maximum.`;
      if (nextRestrictionAt) answer += ` Restrictions begin at ${formatTime(nextRestrictionAt)}.`;
      return { answer, can_park: true };
    }

    default:
      return {
        answer: "Unable to read this sign clearly. Please check the posted sign directly.",
        can_park: null,
      };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set." }, { status: 503 });
  }

  let imageBase64: string;
  let latitude: number | null = null;
  let longitude: number | null = null;

  try {
    const body = await req.json();
    imageBase64 = body.image;
    if (!imageBase64) throw new Error("missing image");
    if (typeof body.latitude === "number")  latitude  = body.latitude;
    if (typeof body.longitude === "number") longitude = body.longitude;
  } catch {
    return NextResponse.json({ error: "Body must be JSON with an `image` field." }, { status: 400 });
  }

  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  // ── Gemini Vision ──────────────────────────────────────────────────────────
  const ai = new GoogleGenAI({ apiKey });
  let rawJson: string;
  try {
    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        { inlineData: { mimeType: "image/jpeg", data: base64Data } },
        { text: PROMPT },
      ],
    });
    rawJson = (result.text ?? "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gemini error: ${msg}` }, { status: 502 });
  }

  let parsed: ExtractedParkingData;
  try {
    const clean = rawJson.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    parsed = JSON.parse(clean) as ExtractedParkingData;
  } catch {
    return NextResponse.json({ error: "Gemini returned unparseable JSON", raw: rawJson }, { status: 500 });
  }

  parsed.parking_type = deriveParkingType(parsed.rules);

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
