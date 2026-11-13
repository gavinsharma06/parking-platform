import { timingSafeEqual } from "crypto";

export function isAuthorizedCron(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret || !authHeader) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authHeader);

  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}
