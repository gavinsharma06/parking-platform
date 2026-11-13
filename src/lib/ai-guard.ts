import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_AUTH_COOKIE, verifyAdminSessionToken } from "@/lib/admin-auth";
import {
  base64DecodedBytes,
  getAiLimits,
  isJpegBase64,
  selectRateTier,
  stripDataUriPrefix,
} from "@/lib/ai-limits";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit-guard";
import { getClientIp, PayloadTooLargeError, readJsonBody } from "@/lib/request";

// ─── Guards shared by every route that calls the AI model ─────────────────────
// Order in a route must be: enforceAiRateLimit → readImageRequest → model call,
// so a blocked or invalid request never costs an AI call.

/**
 * Applies the per-minute and per-day limits for `route`.
 * Returns a response to send when the request must be stopped, or null to continue.
 */
export async function enforceAiRateLimit(
  req: NextRequest,
  route: string,
): Promise<NextResponse | null> {
  const session = await verifyAdminSessionToken(req.cookies.get(ADMIN_AUTH_COOKIE)?.value);
  const tier = selectRateTier(session?.username ?? null, getClientIp(req.headers));

  const outcome = await checkRateLimit(`${route}:${tier.tier}`, tier.identifier, tier.windows);

  if (outcome.status === "unavailable") {
    return NextResponse.json(
      { error: "This feature is temporarily unavailable. Please try again later." },
      { status: 503 },
    );
  }

  if (outcome.status === "limited") {
    const error =
      outcome.window.name === "minute"
        ? "Too many requests. Please wait a moment before trying again."
        : `Daily limit reached. You can check up to ${outcome.window.max} signs per day.`;

    return NextResponse.json({ error }, { status: 429, headers: rateLimitHeaders(outcome) });
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
