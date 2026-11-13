import { describe, expect, it } from "vitest";

import { resolveSpotSource, SPOT_SOURCE_NOTICE } from "../spot-source";

describe("resolveSpotSource", () => {
  it("is live when the query returns rows", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(resolveSpotSource(rows, null)).toEqual({ source: "live", rows });
  });

  it("is demo when the query succeeds with no rows", () => {
    expect(resolveSpotSource([], null)).toEqual({ source: "demo", rows: [] });
  });

  it("is demo when the query succeeds with null data", () => {
    expect(resolveSpotSource(null, null).source).toBe("demo");
  });

  it("is error when the query fails", () => {
    expect(resolveSpotSource(null, { message: "fetch failed" })).toEqual({ source: "error", rows: [] });
  });

  it("is error even if rows came back alongside the error", () => {
    expect(resolveSpotSource([{ id: "a" }], new Error("partial")).source).toBe("error");
  });
});

describe("SPOT_SOURCE_NOTICE", () => {
  it("has the wording from the issue for both fallback states", () => {
    expect(SPOT_SOURCE_NOTICE.demo).toBe("Demo data, no community spots yet");
    expect(SPOT_SOURCE_NOTICE.error).toBe("Live data unavailable, showing demo spots");
  });
});
