import { createServiceRoleClient } from "./supabase-server";
import type { ExtractedParkingData } from "./parking-rules";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrainingExample {
  raw_text: string;
  approved_extracted_data: ExtractedParkingData;
}

// ─── Supabase fetch ───────────────────────────────────────────────────────────

/**
 * Returns up to `limit` most-recently approved training examples from Supabase.
 *
 * Silently returns [] when:
 *   - Supabase env vars are absent (local dev without DB config)
 *   - The query fails for any reason
 *
 * Callers must never hard-fail when few-shot examples are unavailable — the
 * route still works fine with the base prompt.
 */
export async function fetchFewShotExamples(limit = 5): Promise<TrainingExample[]> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    return [];
  }

  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from("training_examples")
      .select("raw_text, approved_extracted_data")
      .order("approved_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    // Filter out any rows where either field was null/empty (shouldn't happen
    // given the schema, but guards against partially-written rows).
    return data.filter(
      (r) => r.raw_text && r.approved_extracted_data,
    ) as TrainingExample[];
  } catch {
    return [];
  }
}

// ─── Prompt construction ──────────────────────────────────────────────────────

/**
 * The base prompt: TypeScript type schema + parsing rules.
 * Exported so tests can assert the full built prompt contains this content.
 */
export const BASE_PROMPT = `You are a parking sign parser. Analyze this parking sign image and extract all parking rules.

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
  direction: "left" | "right" | "both" | null; // arrow direction printed on the sign panel
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
- direction: look for horizontal arrow symbols (← or →) printed on the sign panel.
  Set "left" if only a left arrow is visible, "right" if only a right arrow, "both" if
  arrows point in both directions, null if you cannot determine direction at all.`;

/**
 * Formats approved training examples into an XML-tagged few-shot block.
 *
 * Returns an empty string when examples is empty — callers can safely
 * concatenate without an unwanted blank section appearing in the prompt.
 *
 * Each shot contains:
 *   - The raw OCR text observed on the sign (what the model "sees" as text)
 *   - The correct structured JSON output that was approved by a human
 *
 * Placing examples between the schema definition and the final output
 * instruction puts them closest to the actual request, which maximises
 * their influence on the model's output format and field judgment.
 */
export function buildFewShotBlock(examples: TrainingExample[]): string {
  if (examples.length === 0) return "";

  const noun = examples.length === 1 ? "example" : "examples";
  const shots = examples
    .map((ex, i) => {
      const json = JSON.stringify(ex.approved_extracted_data, null, 2);
      return (
        `<example index="${i + 1}">\n` +
        `Sign text observed:\n${ex.raw_text.trim()}\n\n` +
        `Correct JSON output:\n${json}\n` +
        `</example>`
      );
    })
    .join("\n\n");

  return (
    `\n\nHere ${examples.length === 1 ? "is" : "are"} ${examples.length} approved real-world ` +
    `${noun} from Halifax parking signs. ` +
    `Use them to calibrate your field values and JSON structure:\n\n` +
    `<examples>\n${shots}\n</examples>`
  );
}

/**
 * Assembles the full Gemini prompt:
 *   BASE_PROMPT  →  few-shot block (if available)  →  output instruction
 *
 * The few-shot block is omitted entirely when no examples exist, keeping the
 * prompt identical to the original static prompt for zero-example cases.
 */
export function buildPrompt(examples: TrainingExample[]): string {
  return (
    BASE_PROMPT +
    buildFewShotBlock(examples) +
    "\n\nRespond with raw JSON only, no markdown, no code fences."
  );
}
