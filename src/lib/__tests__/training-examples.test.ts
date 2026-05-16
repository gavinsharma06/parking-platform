import { describe, it, expect } from "vitest";
import {
  buildFewShotBlock,
  buildPrompt,
  BASE_PROMPT,
  type TrainingExample,
} from "../training-examples";
import type { ExtractedParkingData } from "../parking-rules";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_DATA: ExtractedParkingData = {
  rules: [
    {
      rule_type: "no_parking",
      is_prohibited: true,
      days: [1, 2, 3, 4, 5],
      time_window: { start: "07:00", end: "09:00" },
      time_limit_minutes: null,
      cost_per_hour: null,
      permit_zone: null,
      tow_away: false,
      direction: "both",
      raw_text: "NO PARKING 7AM-9AM MON-FRI",
    },
  ],
  raw_text: "NO PARKING 7AM-9AM MON-FRI",
  confidence: 0.95,
  parking_type: "free",
  time_limit_minutes: null,
  cost_per_hour: null,
  schedule: "07:00–09:00",
};

function makeExample(overrides?: Partial<TrainingExample>): TrainingExample {
  return {
    raw_text: "NO PARKING 7AM-9AM MON-FRI",
    approved_extracted_data: BASE_DATA,
    ...overrides,
  };
}

// ─── buildFewShotBlock ────────────────────────────────────────────────────────

describe("buildFewShotBlock", () => {
  it("returns empty string when given no examples", () => {
    expect(buildFewShotBlock([])).toBe("");
  });

  it("uses singular noun for a single example", () => {
    const block = buildFewShotBlock([makeExample()]);
    expect(block).toContain("1 approved real-world example");
    expect(block).not.toContain("examples from");
  });

  it("uses plural noun for multiple examples", () => {
    const block = buildFewShotBlock([makeExample(), makeExample()]);
    expect(block).toContain("2 approved real-world examples");
  });

  it("includes <examples> XML wrapper", () => {
    const block = buildFewShotBlock([makeExample()]);
    expect(block).toContain("<examples>");
    expect(block).toContain("</examples>");
  });

  it("includes indexed <example> tags for each shot", () => {
    const block = buildFewShotBlock([makeExample(), makeExample(), makeExample()]);
    expect(block).toContain('<example index="1">');
    expect(block).toContain('<example index="2">');
    expect(block).toContain('<example index="3">');
  });

  it("embeds the raw sign text in each example", () => {
    const ex = makeExample({ raw_text: "PAID PARKING 8AM-6PM MON-SAT" });
    const block = buildFewShotBlock([ex]);
    expect(block).toContain("PAID PARKING 8AM-6PM MON-SAT");
  });

  it("embeds the approved JSON output in each example", () => {
    const block = buildFewShotBlock([makeExample()]);
    // Key fields from BASE_DATA should appear in the block
    expect(block).toContain('"rule_type": "no_parking"');
    expect(block).toContain('"confidence": 0.95');
  });

  it("trims leading/trailing whitespace from raw_text", () => {
    const ex = makeExample({ raw_text: "  NO STOPPING  " });
    const block = buildFewShotBlock([ex]);
    expect(block).toContain("NO STOPPING");
    expect(block).not.toContain("  NO STOPPING  ");
  });

  it("handles up to 5 examples (the standard limit)", () => {
    const examples = Array.from({ length: 5 }, (_, i) =>
      makeExample({ raw_text: `SIGN ${i + 1}` }),
    );
    const block = buildFewShotBlock(examples);
    expect(block).toContain("5 approved real-world examples");
    for (let i = 1; i <= 5; i++) {
      expect(block).toContain(`SIGN ${i}`);
      expect(block).toContain(`<example index="${i}">`);
    }
  });
});

// ─── buildPrompt ──────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("starts with the base prompt content", () => {
    const prompt = buildPrompt([]);
    expect(prompt.startsWith(BASE_PROMPT)).toBe(true);
  });

  it("ends with the JSON-only output instruction", () => {
    const prompt = buildPrompt([]);
    expect(prompt.trimEnd()).toMatch(
      /Respond with raw JSON only, no markdown, no code fences\.$/,
    );
  });

  it("contains no <examples> block when there are no examples", () => {
    const prompt = buildPrompt([]);
    expect(prompt).not.toContain("<examples>");
    expect(prompt).not.toContain("real-world example");
  });

  it("injects the few-shot block between base prompt and output instruction", () => {
    const prompt = buildPrompt([makeExample()]);
    const baseEnd   = prompt.indexOf("Respond with raw JSON only");
    const examplesStart = prompt.indexOf("<examples>");
    const baseStart = prompt.indexOf(BASE_PROMPT);

    // Order must be: BASE_PROMPT content → <examples> → output instruction
    expect(baseStart).toBeLessThan(examplesStart);
    expect(examplesStart).toBeLessThan(baseEnd);
  });

  it("produces identical output to base prompt + instruction when given no examples", () => {
    const expected =
      BASE_PROMPT + "\n\nRespond with raw JSON only, no markdown, no code fences.";
    expect(buildPrompt([])).toBe(expected);
  });

  it("includes example content in the full prompt", () => {
    const prompt = buildPrompt([makeExample({ raw_text: "STREET CLEANING THU 12AM-8AM" })]);
    expect(prompt).toContain("STREET CLEANING THU 12AM-8AM");
    expect(prompt).toContain('"rule_type": "no_parking"');
  });
});
