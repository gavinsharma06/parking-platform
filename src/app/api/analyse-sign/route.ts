import { NextRequest, NextResponse } from "next/server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtractedParkingData = {
  parking_type: "free" | "paid" | "permit" | "accessible" | "unknown";
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  schedule: string | null;
  raw_text: string;
};

type VisionResponse = {
  responses: Array<{
    textAnnotations?: Array<{ description: string }>;
    error?: { message: string };
  }>;
};

// ─── Text parser ──────────────────────────────────────────────────────────────
// Covers the most common Halifax parking sign patterns

function parseParkingText(text: string): Omit<ExtractedParkingData, "raw_text"> {
  const upper = text.toUpperCase();

  // Parking type
  let parking_type: ExtractedParkingData["parking_type"] = "unknown";
  if (/ACCESSIBLE|HANDICAP|DISABILITY|DISABLED/.test(upper)) {
    parking_type = "accessible";
  } else if (/PERMIT ONLY|PERMIT PARKING|ZONE [A-Z]\d*/.test(upper)) {
    parking_type = "permit";
  } else if (/PAY\s*(HERE|STATION)|METER|\$\s*\d+(\.\d+)?\s*(\/|\bPER\b)\s*H/.test(upper)) {
    parking_type = "paid";
  } else if (/FREE PARKING|NO (FEE|CHARGE)|NO PARKING FEE/.test(upper)) {
    parking_type = "free";
  } else if (/\d+\s*(HOUR|HR|MIN(UTE)?)\s*PARKING/.test(upper)) {
    // Time-limited but no cost mentioned → free
    parking_type = "free";
  }

  // Time limit — "2 HOUR", "1HR", "30 MIN", "HR2"
  let time_limit_minutes: number | null = null;
  const hourMatch =
    upper.match(/(\d+(?:\.\d+)?)\s*[-\s]?\s*H(OUR|R)S?\s*PARKING/) ??
    upper.match(/HR\s*(\d+)/);
  const minMatch = upper.match(/(\d+)\s*MIN(UTE)?S?\s*PARKING/);

  if (hourMatch) {
    time_limit_minutes = Math.round(parseFloat(hourMatch[1]) * 60);
  } else if (minMatch) {
    time_limit_minutes = parseInt(minMatch[1], 10);
  }

  // Cost — "$2.00/HR", "$1.50 PER HOUR", "2.00/HOUR"
  let cost_per_hour: number | null = null;
  const costMatch = upper.match(/\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:\/|\bPER\b)\s*H(OUR|R)/);
  if (costMatch) {
    cost_per_hour = parseFloat(costMatch[1]);
    parking_type = "paid";
  }

  // Schedule — capture any time range present (e.g. "8AM-6PM MON-FRI")
  const scheduleMatch = text.match(
    /\d{1,2}(?::\d{2})?\s*[AP]M?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*[AP]M?(?:\s+[A-Z]{3}(?:[-–][A-Z]{3})?(?:\s*[A-Z]{3}(?:[-–][A-Z]{3})?)*)?/i,
  );
  const schedule = scheduleMatch ? scheduleMatch[0].trim() : null;

  return { parking_type, time_limit_minutes, cost_per_hour, schedule };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Supports both naming conventions (NEXT_PUBLIC_ for local dev convenience,
  // GOOGLE_VISION_API_KEY preferred for production — no browser exposure)
  const apiKey =
    process.env.GOOGLE_VISION_API_KEY ??
    process.env.NEXT_PUBLIC_VISION_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Google Vision API key not set. Add GOOGLE_VISION_API_KEY to .env." },
      { status: 503 },
    );
  }

  let imageBase64: string;
  try {
    const body = await req.json();
    imageBase64 = body.image;
    if (!imageBase64) throw new Error("missing image field");
  } catch {
    return NextResponse.json({ error: "Body must be JSON with an `image` field (base64 JPEG)." }, { status: 400 });
  }

  // Call Google Vision text detection
  const visionRes = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
          },
        ],
      }),
    },
  );

  if (!visionRes.ok) {
    const err = await visionRes.text();
    return NextResponse.json({ error: `Vision API error: ${err}` }, { status: 502 });
  }

  const visionData: VisionResponse = await visionRes.json();
  const annotation = visionData.responses[0];

  if (annotation.error) {
    return NextResponse.json({ error: annotation.error.message }, { status: 502 });
  }

  const raw_text = annotation.textAnnotations?.[0]?.description ?? "";
  const extracted = parseParkingText(raw_text);

  return NextResponse.json({ ...extracted, raw_text } satisfies ExtractedParkingData);
}
