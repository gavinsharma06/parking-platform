import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_AUTH_COOKIE, verifyAdminSessionToken } from "@/lib/admin-auth";
import {
  base64DecodedBytes,
  getAiLimits,
  isJpegBase64,
  selectRateTier,
  stripDataUriPrefix,
} from "@/lib/ai-limits";
import { getLimiter, isRateLimitConfigured } from "@/lib/ratelimit";
import { getClientIp, PayloadTooLargeError, readJsonBody } from "@/lib/request";

// ─── Guards shared by every route that calls the AI model ─────────────────────
// Order in a route must be: enforceAiRateLimit → readImageRequest → model call,
// so a blocked or invalid request never costs an AI call.

function isProductionDeployment(): boolean {
  // VERCEL_ENV separates production from preview; NODE_ENV covers other hosts.
  const vercelEnv = process.env.VERCEL_ENV;
  return vercelEnv ? vercelEnv === "production" : process.env.NODE_ENV === "production";
}

function rateLimitUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "This feature is temporarily unavailable. Please try again later." },
    { status: 503 },
  );
}

let warnedMissingConfig = false;

/**
 * Applies the per-minute and per-day limits for `route`.
 * Returns a response to send when the request must be stopped, or null to continue.
 */
export async function enforceAiRateLimit(
  req: NextRequest,
  route: string,
): Promise<NextResponse | null> {
  if (!isRateLimitConfigured()) {
    // Never serve unlimited AI calls in production because of a missing env var.
    if (isProductionDeployment()) {
      console.error("[rate-limit] Upstash env vars are missing; refusing AI request.");
      return rateLimitUnavailable();
    }
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn("[rate-limit] Upstash env vars are not set; AI routes are not rate limited.");
    }
    return null;
  }

  const session = await verifyAdminSessionToken(req.cookies.get(ADMIN_AUTH_COOKIE)?.value);
  const tier = selectRateTier(session?.username ?? null, getClientIp(req.headers));

  try {
    // Checked in order (minute, then day) so a request blocked by the short
    // window does not also use up the daily allowance.
    for (const window of tier.windows) {
      const limiter = getLimiter(`${route}:${tier.tier}:${window.name}`, window.max, window.window);
      const result = await limiter.limit(tier.identifier);

      if (!result.success) {
        const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
        const error =
          window.name === "minute"
            ? "Too many requests. Please wait a moment before trying again."
            : `Daily limit reached. You can check up to ${window.max} signs per day.`;

        return NextResponse.json(
          { error },
          {
            status: 429,
            headers: {
              "Retry-After":           String(retryAfterSeconds),
              "X-RateLimit-Limit":     String(result.limit),
              "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
            },
          },
        );
      }
    }
  } catch (err) {
    console.error("[rate-limit] check failed:", err instanceof Error ? err.message : err);
    if (isProductionDeployment()) return rateLimitUnavailable();
  }

  return null;
}

// ─── Image payload ────────────────────────────────────────────────────────────

export type ImageRequest =
  | { ok: true; body: Record<string, unknown>; imageBase64: string }
  | { ok: false; response: NextResponse };

function tooLarge(): ImageRequest {
  return {
    ok: false,
    response: NextResponse.json({ error: "Image too large" }, { status: 413 }),
  };
}

function badRequest(error: string): ImageRequest {
  return { ok: false, response: NextResponse.json({ error }, { status: 400 }) };
}

/**
 * Reads a JSON body of the form `{ image: <base64 JPEG or data URI>, ... }`,
 * rejecting oversized bodies and images before anything expensive happens.
 */
export async function readImageRequest(req: NextRequest): Promise<ImageRequest> {
  const { maxBodyBytes, maxImageBytes } = getAiLimits();

  let parsed: unknown;
  try {
    parsed = await readJsonBody(req, maxBodyBytes);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return tooLarge();
    return badRequest("Body must be JSON with an `image` field (base64 JPEG).");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return badRequest("Body must be JSON with an `image` field (base64 JPEG).");
  }

  const body = parsed as Record<string, unknown>;
  if (typeof body.image !== "string" || body.image.length === 0) {
    return badRequest("Body must be JSON with an `image` field (base64 JPEG).");
  }

  const imageBase64 = stripDataUriPrefix(body.image);
  if (base64DecodedBytes(imageBase64) > maxImageBytes) return tooLarge();
  if (!isJpegBase64(imageBase64)) return badRequest("Image must be a base64 encoded JPEG.");

  return { ok: true, body, imageBase64 };
}
