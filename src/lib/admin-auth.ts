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

function getSessionSecret(): string | null {
  const explicitSecret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (explicitSecret) return explicitSecret;

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
