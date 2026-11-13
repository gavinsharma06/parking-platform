import { describe, expect, it } from "vitest";

import { generateAnswer, nextRestrictionStart } from "../parking-answer";
import {
  evaluateSpot,
  HALIFAX_DEFAULT_PAID_RULES,
  isRuleActive,
  localClock,
  PARKING_TIME_ZONE,
} from "../parking-rules";
import type { ParkingRule } from "../parking-rules";

// Every instant below is written in UTC ("Z"), so these tests give the same
// result whatever TZ the process runs in. Halifax is UTC-3 in summer (ADT)
// and UTC-4 in winter (AST).

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

const SUMMER_WED_5PM = new Date("2026-07-15T20:00:00Z"); // 17:00 ADT
const SUMMER_WED_7PM = new Date("2026-07-15T22:00:00Z"); // 19:00 ADT
const WINTER_WED_5PM = new Date("2026-01-14T21:00:00Z"); // 17:00 AST
const WINTER_WED_7PM = new Date("2026-01-14T23:00:00Z"); // 19:00 AST

// ─── localClock ───────────────────────────────────────────────────────────────

describe("localClock", () => {
  it("defaults to the Halifax timezone", () => {
    expect(PARKING_TIME_ZONE).toBe("America/Halifax");
  });

  it("reads Halifax time during daylight saving (UTC-3)", () => {
    expect(localClock(SUMMER_WED_5PM)).toEqual({ day: 3, minutes: 17 * 60 });
  });

  it("reads Halifax time during standard time (UTC-4)", () => {
    expect(localClock(WINTER_WED_5PM)).toEqual({ day: 3, minutes: 17 * 60 });
  });

  it("uses the Halifax weekday when UTC is already on the next day", () => {
    // Saturday 01:30 UTC is still Friday 22:30 in Halifax
    expect(localClock(new Date("2026-07-18T01:30:00Z"))).toEqual({ day: 5, minutes: 22 * 60 + 30 });
  });

  it("reports midnight as minute 0, not 24:00", () => {
    expect(localClock(new Date("2026-07-15T03:00:00Z"))).toEqual({ day: 3, minutes: 0 });
  });

  it("handles the spring-forward day (clocks skip 2AM to 3AM)", () => {
    // 2026-03-08: 05:59Z is 01:59 AST, 06:00Z is 03:00 ADT
    expect(localClock(new Date("2026-03-08T05:59:00Z")).minutes).toBe(1 * 60 + 59);
    expect(localClock(new Date("2026-03-08T06:00:00Z")).minutes).toBe(3 * 60);
  });

  it("accepts another timezone", () => {
    expect(localClock(SUMMER_WED_5PM, "America/Vancouver")).toEqual({ day: 3, minutes: 13 * 60 });
  });

  it("falls back to Halifax for an unknown timezone name", () => {
    expect(localClock(SUMMER_WED_5PM, "Not/AZone")).toEqual({ day: 3, minutes: 17 * 60 });
  });
});

// ─── evaluateSpot in Halifax time ─────────────────────────────────────────────

describe("evaluateSpot — Halifax time", () => {
  it("meter is enforced at 5PM Halifax in summer", () => {
    expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, SUMMER_WED_5PM).status).toBe("paid");
  });

  it("meter is free at 7PM Halifax in summer", () => {
    expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, SUMMER_WED_7PM).status).toBe("free");
  });

  it("meter is enforced at 5PM Halifax in winter", () => {
    expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, WINTER_WED_5PM).status).toBe("paid");
  });

  it("meter is free at 7PM Halifax in winter", () => {
    expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, WINTER_WED_7PM).status).toBe("free");
  });

  it("weekday rule still applies Friday evening when UTC is already Saturday", () => {
    const fridayNight = rule({
      rule_type: "no_parking",
      is_prohibited: true,
      days: [5],
      time_window: { start: "20:00", end: "23:00" },
    });
    const instant = new Date("2026-07-18T01:30:00Z"); // Fri 22:30 ADT

    expect(isRuleActive(fridayNight, instant)).toBe(true);
    expect(evaluateSpot([fridayNight], instant).status).toBe("no_parking");
  });

  it("weekday meter does not apply Sunday evening when UTC is already Monday", () => {
    const instant = new Date("2026-07-20T12:30:00Z"); // Mon 09:30 ADT → paid
    const sundayNight = new Date("2026-07-20T01:30:00Z"); // Sun 22:30 ADT → free

    expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, instant).status).toBe("paid");
    expect(evaluateSpot(HALIFAX_DEFAULT_PAID_RULES, sundayNight).status).toBe("free");
  });
});

// ─── generateAnswer ───────────────────────────────────────────────────────────

describe("generateAnswer — Halifax time", () => {
  const meter = rule({
    rule_type: "paid",
    days: [1, 2, 3, 4, 5],
    time_window: { start: "08:00", end: "18:00" },
    time_limit_minutes: 120,
  });

  it("says paid, with the enforcement end, at 5PM Halifax", () => {
    const result = generateAnswer([meter], SUMMER_WED_5PM);

    expect(result.can_park).toBe(true);
    expect(result.answer).toBe("Yes — paid parking, 2h maximum. Meters enforced until 6PM.");
  });

  it("says free at 7PM Halifax", () => {
    const result = generateAnswer([meter], SUMMER_WED_7PM);

    expect(result.can_park).toBe(true);
    expect(result.answer).toContain("free");
  });

  it("says no during a timed restriction and when it lifts", () => {
    const rushHour = rule({
      rule_type: "no_parking",
      is_prohibited: true,
      days: [1, 2, 3, 4, 5],
      time_window: { start: "16:00", end: "18:00" },
    });

    const result = generateAnswer([rushHour], SUMMER_WED_5PM);

    expect(result.can_park).toBe(false);
    expect(result.answer).toBe("No — no parking right now. Restriction lifts at 6PM.");
  });

  it("warns about a restriction that starts later the same Halifax day", () => {
    const evening = rule({
      rule_type: "no_parking",
      is_prohibited: true,
      time_window: { start: "18:00", end: "20:00" },
    });

    const result = generateAnswer([evening], SUMMER_WED_5PM);

    expect(result.can_park).toBe(true);
    expect(result.answer).toBe("Yes — free to park here. Restrictions begin at 6PM.");
  });

  it("returns can_park null when there are no rules", () => {
    expect(generateAnswer([], SUMMER_WED_5PM).can_park).toBeNull();
  });
});

describe("nextRestrictionStart", () => {
  const morning = rule({ rule_type: "no_parking", is_prohibited: true, time_window: { start: "07:00", end: "09:00" } });
  const evening = rule({ rule_type: "no_parking", is_prohibited: true, time_window: { start: "18:00", end: "20:00" } });
  const permit  = rule({ rule_type: "permit_only", time_window: { start: "17:30", end: "23:00" } });

  it("returns the earliest restriction still ahead today", () => {
    expect(nextRestrictionStart([morning, evening, permit], { day: 3, minutes: 17 * 60 })).toBe("17:30");
  });

  it("ignores restrictions that have already started", () => {
    expect(nextRestrictionStart([morning], { day: 3, minutes: 17 * 60 })).toBeNull();
  });

  it("ignores restrictions that do not apply on this weekday", () => {
    const weekdayOnly = { ...evening, days: [1, 2, 3, 4, 5] };
    expect(nextRestrictionStart([weekdayOnly], { day: 6, minutes: 17 * 60 })).toBeNull();
  });

  it("ignores paid and free rules", () => {
    const paid = rule({ rule_type: "paid", time_window: { start: "18:00", end: "20:00" } });
    expect(nextRestrictionStart([paid], { day: 3, minutes: 17 * 60 })).toBeNull();
  });
});
