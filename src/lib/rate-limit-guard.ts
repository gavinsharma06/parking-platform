import type { Duration } from "@upstash/ratelimit";

import { getLimiter, isRateLimitConfigured } from "./ratelimit";

// ─── Rate limit check shared by every limited route ───────────────────────────

export type RateWindow = {
  /** Short label used in the counter key, e.g. "minute" or "day". */
  name: string;
  max: number;
  window: Duration;
};

export type RateLimitOutcome =
  | { status: "allowed" }
  | { status: "limited"; window: RateWindow; retryAfterSeconds: number; limit: number; remaining: number }
  /** The limiter is not configured or cannot be reached, and this is production. */
  | { status: "unavailable" };

export function isProductionDeployment(): boolean {
  // VERCEL_ENV separates production from preview; NODE_ENV covers other hosts.
  const vercelEnv = process.env.VERCEL_ENV;
  return vercelEnv ? vercelEnv === "production" : process.env.NODE_ENV === "production";
}

let warnedMissingConfig = false;

/**
 * Checks `identifier` against each window of `scope`, in order, stopping at
 * the first one that is exhausted so later windows are not spent on a request
 * that is blocked anyway.
 *
 * In production a missing or unreachable limiter returns "unavailable" (fail
 * closed) rather than letting requests through unlimited. Elsewhere it allows
 * the request and logs a warning.
 */
export async function checkRateLimit(
  scope: string,
  identifier: string,
  windows: RateWindow[],
): Promise<RateLimitOutcome> {
  if (!isRateLimitConfigured()) {
    if (isProductionDeployment()) {
      console.error(`[rate-limit] Upstash env vars are missing; refusing ${scope} request.`);
      return { status: "unavailable" };
    }
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn("[rate-limit] Upstash env vars are not set; requests are not rate limited.");
    }
    return { status: "allowed" };
  }

  try {
    for (const window of windows) {
      const limiter = getLimiter(`${scope}:${window.name}`, window.max, window.window);
      const result = await limiter.limit(identifier);

      if (!result.success) {
        return {
          status: "limited",
          window,
          retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
          limit: result.limit,
          remaining: Math.max(0, result.remaining),
        };
      }
    }
  } catch (err) {
    console.error(`[rate-limit] ${scope} check failed:`, err instanceof Error ? err.message : err);
    if (isProductionDeployment()) return { status: "unavailable" };
  }

  return { status: "allowed" };
}

/** Standard headers for a 429 response. */
export function rateLimitHeaders(
  outcome: Extract<RateLimitOutcome, { status: "limited" }>,
): Record<string, string> {
  return {
    "Retry-After":           String(outcome.retryAfterSeconds),
    "X-RateLimit-Limit":     String(outcome.limit),
    "X-RateLimit-Remaining": String(outcome.remaining),
  };
}
