import { describe, expect, it } from "vitest";

import { isAuthorizedCron } from "../cron-auth";

describe("isAuthorizedCron", () => {
  const secret = "test-cron-secret";

  it("rejects a missing authorization header", () => {
    expect(isAuthorizedCron(null, secret)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(isAuthorizedCron("Bearer wrong-secret", secret)).toBe(false);
  });

  it("accepts the correct secret", () => {
    expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("rejects every request when the secret is undefined", () => {
    expect(isAuthorizedCron("Bearer undefined", undefined)).toBe(false);
  });

  it("rejects every request when the secret is an empty string", () => {
    expect(isAuthorizedCron("Bearer ", "")).toBe(false);
  });
});
