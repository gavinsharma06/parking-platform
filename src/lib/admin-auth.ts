export const ADMIN_AUTH_COOKIE = "admin_auth";
export const ADMIN_USER_COOKIE = "admin_user";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

type AdminSessionPayload = {
  u: string;
  exp: number;
};

export type AdminSession = {
  username: string;
};

export function normalizeAdminUsername(username: unknown): string {
  return typeof username === "string" ? username.toLowerCase().trim() : "";
}

export function getAdminPassword(username: string): string | undefined {
  const admins: Record<string, string | undefined> = {
    gavin: process.env.ADMIN_GAVIN_PASSWORD,
    ishant: process.env.ADMIN_ISHANT_PASSWORD,
  };

  return admins[normalizeAdminUsername(username)];
}

// ─── Password check ───────────────────────────────────────────────────────────

/** Compared against when the username is unknown, so both paths take the same time. */
const UNKNOWN_USER_PASSWORD = "unknown-admin-user";

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Checks a login attempt without leaking, through response time, how much of
 * the password was right or whether the username exists. Both values are
 * hashed first so the comparison always runs over the same number of bytes.
 */
export async function verifyAdminPassword(username: string, password: unknown): Promise<boolean> {
  const expected = getAdminPassword(username);
  const [expectedHash, actualHash] = await Promise.all([
    sha256(expected ?? UNKNOWN_USER_PASSWORD),
    sha256(typeof password === "string" ? password : ""),
  ]);

  let difference = 0;
  for (let i = 0; i < expectedHash.length; i++) {
    difference |= expectedHash[i] ^ actualHash[i];
  }

  return difference === 0 && Boolean(expected) && typeof password === "string" && password.length > 0;
}

// ─── Login attempt limits ─────────────────────────────────────────────────────

const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_LOGIN_WINDOW_MINUTES = 10;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Login attempts allowed per IP. Override with ADMIN_LOGIN_MAX_ATTEMPTS / ADMIN_LOGIN_WINDOW_MINUTES. */
export function getAdminLoginLimit(): { name: string; max: number; window: `${number} m` } {
  const minutes = positiveInt(process.env.ADMIN_LOGIN_WINDOW_MINUTES, DEFAULT_LOGIN_WINDOW_MINUTES);
  return {
    name: "attempts",
    max: positiveInt(process.env.ADMIN_LOGIN_MAX_ATTEMPTS, DEFAULT_LOGIN_MAX_ATTEMPTS),
    window: `${minutes} m`,
  };
}

// ─── Session cookies ──────────────────────────────────────────────────────────

export function getAdminSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    path: "/",
  };
}

export function getAdminUserCookieOptions() {
  return {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    path: "/",
  };
}

function isProductionDeployment(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  return vercelEnv ? vercelEnv === "production" : process.env.NODE_ENV === "production";
}

/** True when sessions can be signed. In production this requires ADMIN_SESSION_SECRET. */
export function isAdminSessionConfigured(): boolean {
  return getSessionSecret() !== null;
}

function getSessionSecret(): string | null {
  const explicitSecret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (explicitSecret) return explicitSecret;

  // Production must sign with a dedicated secret. Deriving the key from the
  // passwords would make sessions only as strong as the weakest password, and
  // would let anyone who learns a password forge a session for any admin.
  if (isProductionDeployment()) return null;

  const passwordBackedSecret = [
    process.env.ADMIN_GAVIN_PASSWORD,
    process.env.ADMIN_ISHANT_PASSWORD,
  ].filter(Boolean).join("|");
  return passwordBackedSecret || null;
}

function base64UrlEncode(value: string | Uint8Array): string {
  const binary =
    typeof value === "string"
      ? value
      : String.fromCharCode(...value);

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

async function getSigningKey(): Promise<CryptoKey | null> {
  const secret = getSessionSecret();
  if (!secret) return null;

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(payload: string): Promise<string | null> {
  const key = await getSigningKey();
  if (!key) return null;

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function createAdminSessionToken(username: string, now = Date.now()): Promise<string> {
  const key = normalizeAdminUsername(username);
  if (!getAdminPassword(key)) {
    throw new Error("Unknown admin user");
  }

  const payload: AdminSessionPayload = {
    u: key,
    exp: now + ADMIN_SESSION_MAX_AGE_SECONDS * 1_000,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await signPayload(encodedPayload);

  if (!signature) {
    throw new Error("Admin session secret is not configured");
  }

  return `${encodedPayload}.${signature}`;
}

export async function verifyAdminSessionToken(token: string | undefined, now = Date.now()): Promise<AdminSession | null> {
  if (!token) return null;

  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) return null;

  const key = await getSigningKey();
  if (!key) return null;

  let payload: AdminSessionPayload;
  try {
    const signature = Uint8Array.from(base64UrlDecode(encodedSignature), (char) => char.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(encodedPayload));
    if (!valid) return null;

    payload = JSON.parse(base64UrlDecode(encodedPayload)) as AdminSessionPayload;
  } catch {
    return null;
  }

  if (!payload.u || typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (!getAdminPassword(payload.u)) return null;

  return { username: payload.u };
}
