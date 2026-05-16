import { describe, it, expect } from "vitest";
import { evaluateSpot } from "../parking-rules";
import type { ParkingRule } from "../parking-rules";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALWAYS: Pick<ParkingRule, "days" | "time_window"> = { days: null, time_window: null };

function rule(overrides: Partial<ParkingRule>): ParkingRule {
  return {
    rule_type: "free",
    is_prohibited: false,
    days: null,
    time_window: null,
    time_limit_minutes: null,
    cost_per_hour: null,
    permit_zone: null,
    tow_away: false,
    direction: null,
    raw_text: "",
    ...overrides,
  };
}

const NOW = new Date("2026-05-16T14:00:00"); // Saturday 2pm

// ─── evaluateSpot — basic status priority ─────────────────────────────────────

describe("evaluateSpot — basic status", () => {
  it("returns unknown for empty rules", () => {
    expect(evaluateSpot([], NOW).status).toBe("unknown");
  });

  it("returns free for a free rule", () => {
    expect(evaluateSpot([rule({ rule_type: "free" })], NOW).status).toBe("free");
  });

  it("returns paid for a paid rule", () => {
    expect(evaluateSpot([rule({ rule_type: "paid" })], NOW).status).toBe("paid");
  });

  it("returns permit for a permit_only rule", () => {
    expect(evaluateSpot([rule({ rule_type: "permit_only" })], NOW).status).toBe("permit");
  });

  it("returns accessible for an accessible rule", () => {
    expect(evaluateSpot([rule({ rule_type: "accessible" })], NOW).status).toBe("accessible");
  });

  it("returns no_parking for a prohibited no_parking rule", () => {
    expect(evaluateSpot([rule({ rule_type: "no_parking", is_prohibited: true })], NOW).status).toBe("no_parking");
  });

  it("returns no_stopping for a tow_away rule", () => {
    expect(evaluateSpot([rule({ rule_type: "no_stopping", is_prohibited: true, tow_away: true })], NOW).status).toBe("no_stopping");
  });
});

// ─── evaluateSpot — accessible + no_parking conflict (bug fix) ───────────────

describe("evaluateSpot — accessible vs no_parking (bug #2)", () => {
  it("returns accessible when no_parking + accessible rules coexist", () => {
    // Gemini extracts accessible spots as: no_parking (is_prohibited:true) for
    // general public + accessible (is_prohibited:false) for permit holders.
    // The spot should be classified as accessible, not a generic no_parking.
    const rules = [
      rule({ rule_type: "no_parking", is_prohibited: true }),
      rule({ rule_type: "accessible", is_prohibited: false }),
    ];
    expect(evaluateSpot(rules, NOW).status).toBe("accessible");
  });

  it("still returns no_parking when there is no accessible rule alongside", () => {
    const rules = [rule({ rule_type: "no_parking", is_prohibited: true })];
    expect(evaluateSpot(rules, NOW).status).toBe("no_parking");
  });

  it("returns no_stopping (not accessible) when tow_away is also present", () => {
    const rules = [
      rule({ rule_type: "no_stopping", is_prohibited: true, tow_away: true }),
      rule({ rule_type: "accessible", is_prohibited: false }),
    ];
    // Tow-away takes priority over everything
    expect(evaluateSpot(rules, NOW).status).toBe("no_stopping");
  });
});

// ─── evaluateSpot — time-based rules ─────────────────────────────────────────

describe("evaluateSpot — time-based rules", () => {
  it("treats an inactive time-limited rule as implicitly free", () => {
    // No parking 8AM–9AM Mon–Fri; right now it's Saturday 2PM → free
    const rules = [rule({
      rule_type: "no_parking",
      is_prohibited: true,
      days: [1, 2, 3, 4, 5],
      time_window: { start: "08:00", end: "09:00" },
    })];
    expect(evaluateSpot(rules, NOW).status).toBe("free");
  });

  it("applies a rule that is currently within its time window", () => {
    // No parking 8AM–6PM every day; NOW is Saturday 2PM → active
    const rules = [rule({
      rule_type: "no_parking",
      is_prohibited: true,
      time_window: { start: "08:00", end: "18:00" },
    })];
    expect(evaluateSpot(rules, NOW).status).toBe("no_parking");
  });

  it("handles overnight windows correctly", () => {
    // No parking 11PM–6AM; NOW is Saturday 2PM → not active → free
    const rules = [rule({
      rule_type: "no_parking",
      is_prohibited: true,
      time_window: { start: "23:00", end: "06:00" },
    })];
    expect(evaluateSpot(rules, NOW).status).toBe("free");
  });
});

// ─── evaluateSpot — status priority order ────────────────────────────────────

describe("evaluateSpot — priority order", () => {
  it("no_stopping beats no_parking", () => {
    const rules = [
      rule({ rule_type: "no_parking",  is_prohibited: true }),
      rule({ rule_type: "no_stopping", is_prohibited: true, tow_away: true }),
    ];
    expect(evaluateSpot(rules, NOW).status).toBe("no_stopping");
  });

  it("paid beats permit and free", () => {
    const rules = [
      rule({ rule_type: "permit_only" }),
      rule({ rule_type: "paid" }),
      rule({ rule_type: "free" }),
    ];
    expect(evaluateSpot(rules, NOW).status).toBe("paid");
  });

  it("permit beats free", () => {
    const rules = [
      rule({ rule_type: "permit_only" }),
      rule({ rule_type: "free" }),
    ];
    expect(evaluateSpot(rules, NOW).status).toBe("permit");
  });
});
