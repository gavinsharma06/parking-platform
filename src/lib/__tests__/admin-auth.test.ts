import { describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "../admin-auth";

describe("admin auth sessions", () => {
  it("creates a signed admin token that does not expose the password", async () => {
    process.env.ADMIN_SESSION_SECRET = "test-secret";
    process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

    const token = await createAdminSessionToken("gavin", 1_000);

    expect(token.includes("super-secret-password")).toBe(false);
    expect(token.includes("gavin:super-secret-password")).toBe(false);
    expect(await verifyAdminSessionToken(token, 1_000)).toEqual({ username: "gavin" });
  });

  it("rejects tampered admin tokens", async () => {
    process.env.ADMIN_SESSION_SECRET = "test-secret";
    process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

    const token = await createAdminSessionToken("gavin", 1_000);
    const [payload, signature] = token.split(".");
    const tamperedPayload = payload.replace(/.$/, payload.endsWith("a") ? "b" : "a");
    const tampered = `${tamperedPayload}.${signature}`;

    expect(await verifyAdminSessionToken(tampered, 1_000)).toBeNull();
  });

  it("rejects expired admin tokens", async () => {
    process.env.ADMIN_SESSION_SECRET = "test-secret";
    process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

    const token = await createAdminSessionToken("gavin", 1_000);
    const afterExpiry = 1_000 + ADMIN_SESSION_MAX_AGE_SECONDS * 1_000 + 1;

    expect(await verifyAdminSessionToken(token, afterExpiry)).toBeNull();
  });

  it("rejects malformed admin tokens without throwing", async () => {
    process.env.ADMIN_SESSION_SECRET = "test-secret";
    process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

    expect(await verifyAdminSessionToken("not-a-token.%%%")).toBeNull();
  });
});
