import { describe, expect, it } from "vitest";

import { CAPTURE_MAX_DIMENSION, fitWithin } from "../capture";

describe("fitWithin", () => {
  it("leaves a frame that already fits unchanged", () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("scales a landscape frame down to the max dimension", () => {
    expect(fitWithin(3840, 2160, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it("scales a portrait frame by its longest edge", () => {
    expect(fitWithin(2160, 3840, 1280)).toEqual({ width: 720, height: 1280 });
  });

  it("never scales up", () => {
    expect(fitWithin(100, 50, 1280)).toEqual({ width: 100, height: 50 });
  });

  it("uses the configured capture size by default", () => {
    const { width } = fitWithin(CAPTURE_MAX_DIMENSION * 2, 100);
    expect(width).toBe(CAPTURE_MAX_DIMENSION);
  });

  it("handles a video that has not loaded yet", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });
});
