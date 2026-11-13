import { describe, it, expect, afterEach } from "vitest";
import { evaluateSpot, HALIFAX_DEFAULT_PAID_RULES } from "../parking-rules";

// Acceptance criteria for #50: the result must not depend on the host timezone
const HOST_ZONES = ["UTC", "America/Halifax", "America/Vancouver"];

const CASES = [
  // Standard time (AST, UTC-4), Wednesday
  { label: "Wed 14 Jan 17:00 AST", instant: "2026-01-14T17:00:00-04:00", expected: "paid" },
  { label: "Wed 14 Jan 19:00 AST", instant: "2026-01-14T19:00:00-04:00", expected: "free" },
  // Daylight saving time (ADT, UTC-3), Wednesday
  { label: "Wed 15 Jul 17:00 ADT", instant: "2026-07-15T17:00:00-03:00", expected: "paid" },
  { label: "Wed 15 Jul 19:00 ADT", instant: "2026-07-15T19:00:00-03:00", expected: "free" },
];

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("evaluateSpot is independent of process.env.TZ", () => {
  for (const zone of HOST_ZONES) {
    describe(`TZ=${zone}`, () => {
      for (const { label, instant, expected } of CASES) {
        it(`paid Mon–Fri 8AM–6PM is ${expected} at ${label}`, () => {
          process.env.TZ = zone;
          const now = new Date(instant);
          expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, now).status).toBe(expected);
        });
      }
    });
  }

  it("actually changes the host timezone between runs", () => {
    // Sanity check that Node honours TZ changes, otherwise the tests above prove nothing
    const instant = new Date("2026-01-14T19:00:00-04:00");
    process.env.TZ = "UTC";
    const utcHour = instant.getHours();
    process.env.TZ = "America/Vancouver";
    const vancouverHour = instant.getHours();
    expect(utcHour).toBe(23);
    expect(vancouverHour).toBe(15);
  });
});
