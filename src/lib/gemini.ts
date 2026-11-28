import { GoogleGenAI, ThinkingLevel } from "@google/genai";

import { deriveParkingType, RULE_TYPE_LABEL } from "./parking-rules";
import type { ExtractedParkingData, ParkingRule } from "./parking-rules";

// ─── Gemini configuration ─────────────────────────────────────────────────────
// The only place a model name appears. Every setting has a default and an env
// override, so the model can be changed in Vercel without a code change when
// Google retires or renames one.

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** Structured extraction needs little reasoning; low keeps latency and cost down. */
const DEFAULT_THINKING_LEVEL = ThinkingLevel.LOW;

const DEFAULT_TIMEOUT_MS = 30_000;

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low:     ThinkingLevel.LOW,
  medium:  ThinkingLevel.MEDIUM,
  high:    ThinkingLevel.HIGH,
};

export type GeminiConfig = {
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
};

export function getGeminiConfig(): GeminiConfig {
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const level = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  const thinkingLevel = (level && THINKING_LEVELS[level]) || DEFAULT_THINKING_LEVEL;

  const timeout = Number(process.env.GEMINI_TIMEOUT_MS?.trim());
  const timeoutMs = Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;

  return { model, thinkingLevel, timeoutMs };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("GEMINI_API_KEY is not set. Add it to .env.");
    this.name = "GeminiNotConfiguredError";
  }
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

let cachedClient: { key: string; client: GoogleGenAI } | null = null;

/**
 * Returns a shared client, created on first use so the module can be imported
 * at build time without the key. Throws GeminiNotConfiguredError if it is missing.
 */
export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiNotConfiguredError();

  const { timeoutMs } = getGeminiConfig();
  const key = `${apiKey}|${timeoutMs}`;

  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = {
      key,
      client: new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs } }),
    };
  }

  return cachedClient.client;
}

// ─── Sign extraction ──────────────────────────────────────────────────────────

export const SIGN_IMAGE_MIME_TYPE = "image/jpeg";

/** The model call itself failed (network, quota, retired model, timeout). */
export class GeminiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

/** The model answered, but not with the JSON structure the prompt asks for. */
export class GeminiResponseError extends Error {
  constructor(public readonly raw: string) {
    super("Gemini returned unparseable JSON");
    this.name = "GeminiResponseError";
  }
}

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimeLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isCost(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isParkingRule(value: unknown): value is ParkingRule {
  if (!isObject(value)) return false;

  const { rule_type, is_prohibited, days, time_window, tow_away, direction } = value;
  const validDays = days === null || (Array.isArray(days) && days.length > 0 &&
    days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  const validWindow = time_window === null || (isObject(time_window) &&
    typeof time_window.start === "string" && CLOCK_TIME.test(time_window.start) &&
    typeof time_window.end === "string" && (CLOCK_TIME.test(time_window.end) || time_window.end === "24:00"));

  return typeof rule_type === "string" && Object.hasOwn(RULE_TYPE_LABEL, rule_type) &&
    typeof is_prohibited === "boolean" && typeof tow_away === "boolean" && validDays && validWindow &&
    (direction === null || direction === "left" || direction === "right" || direction === "both") &&
    isTimeLimit(value.time_limit_minutes) && isCost(value.cost_per_hour) &&
    (value.permit_zone === null || typeof value.permit_zone === "string") && typeof value.raw_text === "string";
}

/** Parses the model's text into parking data. Throws GeminiResponseError if it cannot. */
export function parseSignResponse(text: string): ExtractedParkingData {
  const raw = text.trim();
  // Strip accidental markdown fences if the model ignores the instruction
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new GeminiResponseError(raw);
  }

  if (!isObject(parsed)) throw new GeminiResponseError(raw);

  const { rules, raw_text, confidence, time_limit_minutes, cost_per_hour, schedule } = parsed;
  if (!Array.isArray(rules) || !rules.every(isParkingRule) || typeof raw_text !== "string" ||
    typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1) ||
    !isTimeLimit(time_limit_minutes) || !isCost(cost_per_hour) ||
    (schedule !== null && typeof schedule !== "string")) {
    throw new GeminiResponseError(raw);
  }

  return { rules, raw_text, confidence, parking_type: deriveParkingType(rules), time_limit_minutes, cost_per_hour, schedule };
}

/**
 * Sends a sign photo and prompt to the configured model and returns the
 * extracted rules.
 *
 * Throws GeminiNotConfiguredError, GeminiRequestError or GeminiResponseError.
 */
export async function extractParkingData(
  imageBase64: string,
  prompt: string,
): Promise<ExtractedParkingData> {
  const client = getGeminiClient();
  const { model, thinkingLevel } = getGeminiConfig();

  let text: string;
  try {
    const result = await client.models.generateContent({
      model,
      contents: [
        { inlineData: { mimeType: SIGN_IMAGE_MIME_TYPE, data: imageBase64 } },
        { text: prompt },
      ],
      config: { thinkingConfig: { thinkingLevel } },
    });
    text = result.text ?? "";
  } catch (err) {
    throw new GeminiRequestError(err instanceof Error ? err.message : String(err));
  }

  return parseSignResponse(text);
}

/** HTTP status and JSON body a route should return for an extraction failure. */
export function geminiErrorResponse(err: unknown): {
  status: number;
  body: { error: string; raw?: string };
} {
  if (err instanceof GeminiNotConfiguredError) {
    return { status: 503, body: { error: err.message } };
  }
  if (err instanceof GeminiResponseError) {
    return { status: 500, body: { error: err.message, raw: err.raw } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 502, body: { error: `Gemini API error: ${message}` } };
}
