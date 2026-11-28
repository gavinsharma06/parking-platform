import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractParkingData, getGeminiConfig } from "../gemini";
import { buildPrompt } from "../training-examples";

const enabled = process.env.GEMINI_LIVE_TEST === "1" && Boolean(process.env.GEMINI_API_KEY);
const sampleDir = path.join(process.cwd(), "parkingsigns");
const weekdays = [1, 2, 3, 4, 5];

const cases = [
  { file: "paidparking.jpg", rules: [{ rule_type: "paid", days: weekdays, time_window: { start: "08:00", end: "18:00" } }] },
  { file: "nostoping.jpg", rules: [{ rule_type: "no_stopping", is_prohibited: true, time_window: null }] },
  { file: "noparkingcauseofstreetcleaning.jpg", rules: [
    { rule_type: "street_cleaning", is_prohibited: true, days: [4], time_window: { start: "00:05", end: "08:00" } },
  ] },
  { file: "noparkinginperticulartime.jpg", rules: [
    { is_prohibited: true, days: weekdays, time_window: { start: "07:00", end: "09:00" } },
    { rule_type: "paid", days: weekdays, time_window: { start: "09:00", end: "18:00" } },
  ] },
  { file: "accesibleonlyparking.jpg", rules: [{ rule_type: "accessible", time_limit_minutes: 180 }] },
  { file: "noparking.jpg", rules: [{ rule_type: "permit_only", days: weekdays, time_window: { start: "08:00", end: "16:00" } }] },
];

// Live checks are opt-in and make one billable request per JPEG.
describe.skipIf(!enabled)(`sign extraction with ${getGeminiConfig().model}`, () => {
  it.each(cases)("reads $file", async ({ file, rules }) => {
    const photo = readFileSync(path.join(sampleDir, file)).toString("base64");
    const extraction = await extractParkingData(photo, buildPrompt([]));

    expect(extraction.rules).toEqual(expect.arrayContaining(rules.map((rule) => expect.objectContaining(rule))));
  }, 60_000);
});
