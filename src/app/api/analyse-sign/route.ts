import { NextRequest, NextResponse } from "next/server";
import type { ParkingRule, RuleType, TimeWindow, ExtractedParkingData } from "@/lib/parking-rules";
import { deriveParkingType } from "@/lib/parking-rules";

// ─── Vision API types ─────────────────────────────────────────────────────────

type VisionResponse = {
  responses: Array<{
    textAnnotations?: Array<{ description: string }>;
    error?: { message: string };
  }>;
};

// ─── Day parsing ──────────────────────────────────────────────────────────────

const DAY_MAP: Record<string, number> = {
  SUN: 0, SUNDAY: 0,
  MON: 1, MONDAY: 1,
  TUE: 2, TUESDAY: 2, TUES: 2,
  WED: 3, WEDNESDAY: 3,
  THU: 4, THURSDAY: 4, THURS: 4,
  FRI: 5, FRIDAY: 5,
  SAT: 6, SATURDAY: 6,
};

const DAY_KEYS = Object.keys(DAY_MAP).join("|");
const DAY_RE = new RegExp(`\\b(${DAY_KEYS})\\b`, "gi");
const RANGE_RE = new RegExp(
  `\\b(${DAY_KEYS})\\s*[-–]\\s*(${DAY_KEYS})\\b`,
  "gi",
);

function parseDays(text: string): number[] | null {
  // Normalize common Vision OCR artifact: leading "I" before day abbreviations (e.g. "IMON-FRI" → "MON-FRI")
  const u = text
    .toUpperCase()
    .replace(/\bI(MON|TUE|TUES|WED|THU|THURS|FRI|SAT|SUN|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\b/g, "$1");
  const days = new Set<number>();

  // Expand day ranges first  e.g. MON-FRI
  for (const m of u.matchAll(RANGE_RE)) {
    const a = DAY_MAP[m[1]];
    const b = DAY_MAP[m[2]];
    if (a !== undefined && b !== undefined) {
      if (a <= b) {
        for (let d = a; d <= b; d++) days.add(d);
      } else {
        // wrap (e.g. FRI-MON)
        for (let d = a; d <= 6; d++) days.add(d);
        for (let d = 0; d <= b; d++) days.add(d);
      }
    }
  }

  // Space-separated day pairs treated as a range (e.g. "MON SAT" on arrow signs = Mon–Sat)
  if (days.size === 0) {
    for (const m of u.matchAll(new RegExp(`\\b(${DAY_KEYS})\\s+(${DAY_KEYS})\\b`, "gi"))) {
      const a = DAY_MAP[m[1]];
      const b = DAY_MAP[m[2]];
      if (a !== undefined && b !== undefined && a !== b) {
        if (a < b) { for (let d = a; d <= b; d++) days.add(d); }
        else        { for (let d = a; d <= 6; d++) days.add(d); for (let d = 0; d <= b; d++) days.add(d); }
      }
    }
  }

  // Individual day names (only if no range matched them already)
  if (days.size === 0) {
    for (const m of u.matchAll(DAY_RE)) {
      const n = DAY_MAP[m[1]];
      if (n !== undefined) days.add(n);
    }
  }

  return days.size > 0 ? Array.from(days).sort((a, b) => a - b) : null;
}

// ─── Time parsing ─────────────────────────────────────────────────────────────

function parseTime(raw: string): string | null {
  // Allow: "8AM" "8:00AM" "8:00 AM" "12:05AM"
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3].toUpperCase() === "AM") { if (h === 12) h = 0; }
  else                              { if (h !== 12) h += 12; }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function parseTimeWindow(text: string): TimeWindow | null {
  const TT = /\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i.source;
  const primaryRe  = new RegExp(`(${TT})\\s*[-–]\\s*(${TT})`, "i");
  // Fallback: "12AM 8AM" — space-separated (common on Halifax street cleaning signs)
  const fallbackRe = new RegExp(`(${TT})\\s+(${TT})`, "i");
  const pm = primaryRe.exec(text);
  const fm = fallbackRe.exec(text);
  // Pick whichever match starts earlier in the text (fallback handles "7AM 9AM" before "9AM-6PM")
  const m = !pm && !fm ? null
          : !pm ? fm
          : !fm ? pm
          : pm.index <= fm.index ? pm : fm;
  if (!m) return null;
  const start = parseTime(m[1].replace(/\s/g, ""));
  const end   = parseTime(m[2].replace(/\s/g, ""));
  if (!start || !end) return null;
  return { start, end };
}

// ─── Cost / time-limit parsing ────────────────────────────────────────────────

function parseCost(text: string): number | null {
  const m = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:\/|\bPER\b)\s*H(?:OUR|R)/i);
  return m ? parseFloat(m[1]) : null;
}

function parseTimeLimit(text: string): number | null {
  // Suffix optional: matches "1H", "1HR", "1HOUR", "1 HR", "2 HOURS"
  // Negative lookahead prevents "8H-6PM" from being read as an 8-hour limit
  const hourM = text.match(/(?<!\d)(\d+(?:\.\d+)?)\s*H(?:OUR|R)?\b(?!\s*[-–]\s*\d)/i);
  const minM  = text.match(/(\d+)\s*MIN(?:UTE)?S?\b/i);
  if (hourM) return Math.round(parseFloat(hourM[1]) * 60);
  if (minM)  return parseInt(minM[1], 10);
  return null;
}

// ─── Permit zone parsing ──────────────────────────────────────────────────────

function parsePermitZone(text: string): string | null {
  const m = text.match(/(?:ZONE|PAY\s*ZONE)\s*[-]?\s*([A-Z][0-9]?|[0-9]+)/i);
  return m ? m[1].toUpperCase() : null;
}

// ─── Sign segmentation ────────────────────────────────────────────────────────

// Each pattern marks the START of a new sign
const SIGN_ANCHORS: RegExp[] = [
  /\bNO\s+STOPPING\b/i,
  /\bNO\s+STANDING\b/i,
  /\bNO\s+PARKING\b/i,
  /\bPAYMENT\s+REQUIRED\b/i,
  /\bPAY\s+(?:ZONE|STATION|HERE)\b/i,
  /\bACCESSIBLE\s+PARKING\b/i,
  /\bEXCEPT\s+BY\s+PERMIT\b/i,
  /\bPERMIT\s+(?:ONLY|PARKING)\b/i,
  /\bSTREET\s+CLEANING\b/i,
  /\bTOW[\s-]+AWAY\b/i,
  /\bFREE\s+PARKING\b/i,
  /\b\d+(?:\.\d+)?\s*(?:HOUR|HR)\s+PARKING\b/i,
  /\b\d+\s*MIN(?:UTE)?\s+PARKING\b/i,
];

const TIME_ONLY_RE = /\d{1,2}(?::\d{2})?\s*(?:AM|PM)/i;
const DAY_ABBREVS  = "SUN|MON|TUE|TUES|WED|THU|THURS|FRI|SAT|SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY";
const DAY_ONLY_RE  = new RegExp(`^(?:(?:${DAY_ABBREVS})[\\s,–-]*)+$`, "i");
// Single chars / parking-symbol lines that carry no parseable info
const NOISE_LINE_RE = /^P$|^[^A-Za-z0-9]+$/;

// Join keyword fragments that Vision commonly splits across lines,
// and fix common digit-letter OCR misreads that appear before AM/PM.
function normalizeRaw(raw: string): string {
  return raw
    // Multi-line keyword joins
    .replace(/\bTOW\s*\n\s*AWAY/gi,       "TOW AWAY")
    .replace(/\bPAY\s*\n\s*ZONE/gi,        "PAY ZONE")
    .replace(/\bNO\s*\n\s*PARKING/gi,      "NO PARKING")
    .replace(/\bNO\s*\n\s*STOPPING/gi,     "NO STOPPING")
    .replace(/\bNO\s*\n\s*STANDING/gi,     "NO STANDING")
    .replace(/\bSTREET\s*\n\s*CLEANING/gi, "STREET CLEANING")
    .replace(/\bPAYMENT\s*\n\s*REQUIRED/gi,"PAYMENT REQUIRED")
    .replace(/\bFREE\s*\n\s*PARKING/gi,    "FREE PARKING")
    // Digit-letter substitutions before AM/PM (Vision OCR artifacts)
    // "8" misread as "B" → BAM→8AM, BPM→8PM
    .replace(/\bB([AP]M)\b/gi, "8$1")
    // "6" misread as "G" → GAM→6AM, GPM→6PM
    .replace(/\bG([AP]M)\b/gi, "6$1");
}

function segmentText(raw: string): string[] {
  const lines = normalizeRaw(raw)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !NOISE_LINE_RE.test(l));

  const segments: string[] = [];
  let current: string[] = [];
  // Time/day-only header lines before the first anchor (e.g. the restriction window
  // above a visual no-stopping arrow) get buffered and prepended to the next sign.
  let pending: string[] = [];

  for (const line of lines) {
    const isAnchor = SIGN_ANCHORS.some((re) => re.test(line));

    if (isAnchor) {
      if (current.length > 0) {
        // Pending is prepended so its time window appears first in the joined text
        segments.push([...pending, ...current].join(" "));
        pending = [];
      }
      current = [line];
    } else if (current.length === 0 && (TIME_ONLY_RE.test(line) || DAY_ONLY_RE.test(line))) {
      // Time/day header before any sign anchor — buffer to attach to the next sign
      pending.push(line);
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    segments.push([...pending, ...current].join(" "));
  } else if (pending.length > 0) {
    segments.push(pending.join(" "));
  }

  return segments.filter((s) => s.trim().length > 3);
}

// ─── Per-segment classification ───────────────────────────────────────────────

function classifySegment(text: string): {
  rule_type: RuleType | null;
  is_prohibited: boolean;
  tow_away: boolean;
} {
  const u = text.toUpperCase();

  if (/\bNO\s+STOPPING\b|\bNO\s+STANDING\b/.test(u)) {
    return { rule_type: "no_stopping", is_prohibited: true, tow_away: /TOW/.test(u) };
  }
  if (/\bSTREET\s+CLEANING\b/.test(u)) {
    return { rule_type: "street_cleaning", is_prohibited: true, tow_away: false };
  }
  if (/\bTOW[\s-]+AWAY\b/.test(u)) {
    return { rule_type: "no_stopping", is_prohibited: true, tow_away: true };
  }
  if (/\bNO\s+PARKING\b/.test(u)) {
    return { rule_type: "no_parking", is_prohibited: true, tow_away: /TOW/.test(u) };
  }
  if (/\bACCESSIBLE/.test(u)) {
    return { rule_type: "accessible", is_prohibited: false, tow_away: false };
  }
  if (/\bEXCEPT\s+BY\s+PERMIT\b|\bPERMIT\s+(?:ONLY|PARKING)\b/.test(u)) {
    return { rule_type: "permit_only", is_prohibited: false, tow_away: false };
  }
  if (/\bPAYMENT\s+REQUIRED\b|\bPAY\s+(?:ZONE|STATION|HERE)\b/.test(u)) {
    return { rule_type: "paid", is_prohibited: false, tow_away: false };
  }
  if (/\bFREE\s+PARKING\b/.test(u)) {
    return { rule_type: "free", is_prohibited: false, tow_away: false };
  }
  // Cost mentioned → paid
  if (/\$|\bPER\s+H(?:OUR|R)\b/.test(u)) {
    return { rule_type: "paid", is_prohibited: false, tow_away: false };
  }
  // Time-limited with no cost → free (matches "1H", "1HR", "1 HOUR", "30 MIN")
  if (/\b\d+\s*H(?:OUR|R)?\b(?!\s*[-–]\s*\d)|\b\d+\s*MIN\b/.test(u)) {
    return { rule_type: "free", is_prohibited: false, tow_away: false };
  }

  return { rule_type: null, is_prohibited: false, tow_away: false };
}

function parseSegment(text: string): ParkingRule | null {
  const { rule_type, is_prohibited, tow_away } = classifySegment(text);
  if (!rule_type) return null;

  return {
    rule_type,
    is_prohibited,
    tow_away,
    days:               parseDays(text),
    time_window:        parseTimeWindow(text),
    time_limit_minutes: parseTimeLimit(text),
    cost_per_hour:      parseCost(text),
    permit_zone:        parsePermitZone(text),
    raw_text:           text.trim(),
  };
}

// ─── Post-processing ─────────────────────────────────────────────────────────

// Drop bare duplicate rules (same type, no time/day/cost info) when a richer
// rule of the same type already exists — avoids "PAY ZONE" creating a phantom
// paid-24/7 rule alongside a properly-timestamped PAYMENT REQUIRED rule.
function deduplicateRules(rules: ParkingRule[]): ParkingRule[] {
  const result: ParkingRule[] = [];
  for (const rule of rules) {
    const isBare =
      !rule.time_window &&
      !rule.days &&
      rule.cost_per_hour == null &&
      rule.time_limit_minutes == null &&
      !rule.permit_zone;
    if (isBare && result.some((r) => r.rule_type === rule.rule_type)) continue;
    result.push(rule);
  }
  return result;
}

// ─── Confidence heuristic ─────────────────────────────────────────────────────

function scoreConfidence(rules: ParkingRule[]): number {
  if (rules.length === 0) return 0.1;
  let score = 0.5;
  if (rules.some((r) => r.time_window))        score += 0.2;
  if (rules.some((r) => r.days))               score += 0.15;
  if (rules.some((r) => r.cost_per_hour != null || r.time_limit_minutes != null)) score += 0.1;
  if (rules.length > 1)                        score += 0.05; // multi-sign pole detected
  return Math.min(score, 1);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const apiKey =
    process.env.GOOGLE_VISION_API_KEY ??
    process.env.NEXT_PUBLIC_VISION_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_VISION_API_KEY is not set. Add it to .env." },
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
  const segments = segmentText(raw_text);
  const rules    = deduplicateRules(
    segments.map(parseSegment).filter((r): r is ParkingRule => r !== null),
  );

  // Derive legacy summary fields for backward compat
  const parking_type      = deriveParkingType(rules);
  const firstPaid         = rules.find((r) => r.rule_type === "paid");
  const firstTimeLimited  = rules.find((r) => r.time_limit_minutes != null);
  const time_limit_minutes = firstTimeLimited?.time_limit_minutes ?? null;
  const cost_per_hour      = firstPaid?.cost_per_hour ?? null;
  const schedule           = rules[0]?.time_window
    ? `${rules[0].time_window.start}–${rules[0].time_window.end}`
    : null;

  const result: ExtractedParkingData = {
    rules,
    raw_text,
    confidence: scoreConfidence(rules),
    parking_type,
    time_limit_minutes,
    cost_per_hour,
    schedule,
  };

  return NextResponse.json(result);
}
