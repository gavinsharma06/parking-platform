import { describe, it, expect } from "vitest";
import { halifaxNow } from "../parking-rules";

describe("halifaxNow", () => {
  it("converts a daylight saving time instant (ADT, UTC-3)", () => {
    // Wed 15 Jul 2026 21:00 UTC is 18:00 ADT
    expect(halifaxNow(new Date("2026-07-15T21:00:00Z"))).toEqual({ day: 3, minutes: 18 * 60 });
  });

  it("converts a standard time instant (AST, UTC-4)", () => {
    // Wed 14 Jan 2026 21:00 UTC is 17:00 AST
    expect(halifaxNow(new Date("2026-01-14T21:00:00Z"))).toEqual({ day: 3, minutes: 17 * 60 });
  });

  it("uses the Halifax weekday when UTC has already rolled over", () => {
    // Sat 17 Jan 2026 02:30 UTC is still Fri 16 Jan 22:30 AST
    expect(halifaxNow(new Date("2026-01-17T02:30:00Z"))).toEqual({ day: 5, minutes: 22 * 60 + 30 });
  });

  it("returns 0 minutes at Halifax midnight", () => {
    // Thu 15 Jan 2026 04:00 UTC is 00:00 AST
    expect(halifaxNow(new Date("2026-01-15T04:00:00Z"))).toEqual({ day: 4, minutes: 0 });
  });

  it("handles the spring forward day (8 Mar 2026)", () => {
    // 06:30 UTC is 03:30 ADT, just after the 02:00 jump
    expect(halifaxNow(new Date("2026-03-08T06:30:00Z"))).toEqual({ day: 0, minutes: 3 * 60 + 30 });
  });
});
