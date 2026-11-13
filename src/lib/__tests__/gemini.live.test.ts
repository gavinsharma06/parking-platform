import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractParkingData, getGeminiConfig } from "../gemini";
import { buildPrompt } from "../training-examples";

// ─── Live model check (opt-in) ────────────────────────────────────────────────
// Sends every sample sign in parkingsigns/ to the configured Gemini model and
// prints what it extracts. Use it before changing GEMINI_MODEL to confirm the
// new model reads the sample signs at least as well as the old one.
//
// It makes one real, billable API call per image, so it only runs when asked:
//
//   GEMINI_LIVE_TEST=1 GEMINI_API_KEY=... npm test -- gemini.live
//   GEMINI_LIVE_TEST=1 GEMINI_API_KEY=... GEMINI_MODEL=<model> npm test -- gemini.live

const SAMPLE_DIR = path.resolve(__dirname, "../../../parkingsigns");
const enabled = process.env.GEMINI_LIVE_TEST === "1" && Boolean(process.env.GEMINI_API_KEY);

const samples = enabled
  ? readdirSync(SAMPLE_DIR).filter((file) => /\.(jpe?g|png)$/i.test(file)).sort()
  : [];

describe.skipIf(!enabled)(`live sign extraction with ${getGeminiConfig().model}`, () => {
  it.each(samples)("%s", async (file) => {
    const imageBase64 = readFileSync(path.join(SAMPLE_DIR, file)).toString("base64");

    const started = Date.now();
    const data = await extractParkingData(imageBase64, buildPrompt([]));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const summary = data.rules
      .map((r) => {
        const window = r.time_window ? `${r.time_window.start}-${r.time_window.end}` : "24/7";
        const days = r.days ? r.days.join("") : "all";
        return `${r.rule_type}[${window} days:${days}${r.direction ? ` ${r.direction}` : ""}]`;
      })
      .join(", ");
    console.log(`${file} (${seconds}s, confidence ${data.confidence}): ${summary}`);

    expect(data.rules.length).toBeGreaterThan(0);
  }, 60_000);
});
