import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "../admin-auth.ts";

test("creates a signed admin token that does not expose the password", async () => {
  process.env.ADMIN_SESSION_SECRET = "test-secret";
  process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

  const token = await createAdminSessionToken("gavin", 1_000);

  assert.equal(token.includes("super-secret-password"), false);
  assert.equal(token.includes("gavin:super-secret-password"), false);
  assert.deepEqual(await verifyAdminSessionToken(token, 1_000), { username: "gavin" });
});

test("rejects tampered admin tokens", async () => {
  process.env.ADMIN_SESSION_SECRET = "test-secret";
  process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

  const token = await createAdminSessionToken("gavin", 1_000);
  const [payload, signature] = token.split(".");
  const tamperedPayload = payload.replace(/.$/, payload.endsWith("a") ? "b" : "a");
  const tampered = `${tamperedPayload}.${signature}`;

  assert.equal(await verifyAdminSessionToken(tampered, 1_000), null);
});

test("rejects expired admin tokens", async () => {
  process.env.ADMIN_SESSION_SECRET = "test-secret";
  process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

  const token = await createAdminSessionToken("gavin", 1_000);
  const afterExpiry = 1_000 + ADMIN_SESSION_MAX_AGE_SECONDS * 1_000 + 1;

  assert.equal(await verifyAdminSessionToken(token, afterExpiry), null);
});

test("rejects malformed admin tokens without throwing", async () => {
  process.env.ADMIN_SESSION_SECRET = "test-secret";
  process.env.ADMIN_GAVIN_PASSWORD = "super-secret-password";

  assert.equal(await verifyAdminSessionToken("not-a-token.%%%"), null);
});
