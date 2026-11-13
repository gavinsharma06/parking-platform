import type { RateWindow } from "./rate-limit-guard";

// ─── Limits for the public AI endpoints ───────────────────────────────────────
// Every value has a default and can be overridden per environment with an env
// var, so limits can be tuned in Vercel without a code change.

const MB = 1024 * 1024;

const DEFAULTS = {
  AI_RATE_LIMIT_PER_MINUTE:       10,
  AI_RATE_LIMIT_PER_DAY:          50,
  AI_ADMIN_RATE_LIMIT_PER_MINUTE: 60,
  AI_ADMIN_RATE_LIMIT_PER_DAY:    500,
  AI_MAX_BODY_BYTES:              4 * MB,
  AI_MAX_IMAGE_BYTES:             3 * MB,
} as const;

type LimitName = keyof typeof DEFAULTS;

function readLimit(name: LimitName): number {
  const raw = process.env[name]?.trim();
  if (!raw) return DEFAULTS[name];

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULTS[name];
}

export type { RateWindow };

export type AiLimits = {
  public: RateWindow[];
  admin: RateWindow[];
  maxBodyBytes: number;
  maxImageBytes: number;
};

export function getAiLimits(): AiLimits {
  return {
    public: [
      { name: "minute", max: readLimit("AI_RATE_LIMIT_PER_MINUTE"), window: "1 m" },
      { name: "day",    max: readLimit("AI_RATE_LIMIT_PER_DAY"),    window: "1 d" },
    ],
    admin: [
      { name: "minute", max: readLimit("AI_ADMIN_RATE_LIMIT_PER_MINUTE"), window: "1 m" },
      { name: "day",    max: readLimit("AI_ADMIN_RATE_LIMIT_PER_DAY"),    window: "1 d" },
    ],
    maxBodyBytes:  readLimit("AI_MAX_BODY_BYTES"),
    maxImageBytes: readLimit("AI_MAX_IMAGE_BYTES"),
  };
}

// ─── Tier selection ───────────────────────────────────────────────────────────

export type RateTier = {
  tier: "public" | "admin";
  /** Key the counters are stored under: one bucket per admin, or per IP. */
  identifier: string;
  windows: RateWindow[];
};

/**
 * Logged-in admins get their own, higher limits keyed by username so testing
 * is not throttled by (and does not eat into) the public per-IP budget.
 */
export function selectRateTier(
  adminUsername: string | null,
  ip: string,
  limits: AiLimits = getAiLimits(),
): RateTier {
  if (adminUsername) {
    return { tier: "admin", identifier: `admin:${adminUsername}`, windows: limits.admin };
  }
  return { tier: "public", identifier: `ip:${ip}`, windows: limits.public };
}

// ─── Image payload helpers ────────────────────────────────────────────────────

/** Removes a `data:image/...;base64,` prefix if the client sent a data URI. */
export function stripDataUriPrefix(image: string): string {
  return image.replace(/^data:image\/[\w.+-]+;base64,/, "");
}

/** Size of the binary a base64 string decodes to, without decoding it. */
export function base64DecodedBytes(base64: string): number {
  const length = base64.length;
  if (length === 0) return 0;

  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;

  return Math.floor((length * 3) / 4) - padding;
}

/** JPEG files start with FF D8 FF, which is always `/9j/` in base64. */
export function isJpegBase64(base64: string): boolean {
  return base64.startsWith("/9j/");
}
