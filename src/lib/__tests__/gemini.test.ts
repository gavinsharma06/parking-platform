import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for the SDK: records what the app asks for and returns canned text.
const sdk = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  requests: [] as { model: string; config?: { thinkingConfig?: { thinkingLevel?: string } } }[],
  responseText: "" as string | undefined,
  error: null as Error | null,
}));

vi.mock("@google/genai", () => ({
  ThinkingLevel: { MINIMAL: "MINIMAL", LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
  GoogleGenAI: class {
    constructor(options: unknown) {
      sdk.clientOptions.push(options);
    }
    models = {
      generateContent: async (request: (typeof sdk.requests)[number]) => {
        sdk.requests.push(request);
        if (sdk.error) throw sdk.error;
        return { text: sdk.responseText };
      },
    };
  },
}));

import {
  extractParkingData,
  geminiErrorResponse,
  GeminiNotConfiguredError,
  GeminiRequestError,
  GeminiResponseError,
  getGeminiClient,
  getGeminiConfig,
  isGeminiConfigured,
  parseSignResponse,
} from "../gemini";

const ENV_VARS = ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_THINKING_LEVEL", "GEMINI_TIMEOUT_MS"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  sdk.clientOptions.length = 0;
  sdk.requests.length = 0;
  sdk.responseText = "";
  sdk.error = null;
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const VALID_JSON = JSON.stringify({
  rules: [
    {
      rule_type: "paid",
      is_prohibited: false,
      days: [1, 2, 3, 4, 5],
      time_window: { start: "08:00", end: "18:00" },
      time_limit_minutes: 120,
      cost_per_hour: 2,
      permit_zone: null,
      tow_away: false,
      direction: null,
      raw_text: "PAY ZONE 8AM-6PM MON-FRI",
    },
  ],
  raw_text: "PAY ZONE 8AM-6PM MON-FRI",
  confidence: 0.9,
  parking_type: "free", // deliberately wrong: must be re-derived from rules
  time_limit_minutes: 120,
  cost_per_hour: 2,
  schedule: "08:00–18:00",
});

// ─── getGeminiConfig ──────────────────────────────────────────────────────────

describe("getGeminiConfig", () => {
  it("defaults to a stable model, never a preview or experimental one", () => {
    const { model } = getGeminiConfig();

    expect(model).toMatch(/^gemini-/);
    expect(model).not.toMatch(/preview|exp|latest/);
  });

  it("defaults to low thinking and a 30 second timeout", () => {
    const config = getGeminiConfig();

    expect(config.thinkingLevel).toBe("LOW");
    expect(config.timeoutMs).toBe(30_000);
  });

  it("reads the model, thinking level and timeout from the environment", () => {
    process.env.GEMINI_MODEL = " some-other-model ";
    process.env.GEMINI_THINKING_LEVEL = "High";
    process.env.GEMINI_TIMEOUT_MS = "5000";

    expect(getGeminiConfig()).toEqual({
      model: "some-other-model",
      thinkingLevel: "HIGH",
      timeoutMs: 5000,
    });
  });

  it("falls back to defaults for an empty model and invalid values", () => {
    process.env.GEMINI_MODEL = "   ";
    process.env.GEMINI_THINKING_LEVEL = "extreme";
    process.env.GEMINI_TIMEOUT_MS = "soon";

    const config = getGeminiConfig();

    expect(config.model).toMatch(/^gemini-/);
    expect(config.thinkingLevel).toBe("LOW");
    expect(config.timeoutMs).toBe(30_000);
  });
});

// ─── getGeminiClient ──────────────────────────────────────────────────────────

describe("getGeminiClient", () => {
  it("throws a clear error when GEMINI_API_KEY is missing", () => {
    expect(isGeminiConfigured()).toBe(false);
    expect(() => getGeminiClient()).toThrow(GeminiNotConfiguredError);
    expect(() => getGeminiClient()).toThrow(/GEMINI_API_KEY/);
  });

  it("creates one client and reuses it", () => {
    process.env.GEMINI_API_KEY = "key-reuse";

    const first = getGeminiClient();
    const second = getGeminiClient();

    expect(second).toBe(first);
    expect(sdk.clientOptions).toHaveLength(1);
  });

  it("passes the API key and timeout to the SDK", () => {
    process.env.GEMINI_API_KEY = "key-options";
    process.env.GEMINI_TIMEOUT_MS = "12000";

    getGeminiClient();

    expect(sdk.clientOptions.at(-1)).toEqual({
      apiKey: "key-options",
      httpOptions: { timeout: 12_000 },
    });
  });
});

// ─── parseSignResponse ────────────────────────────────────────────────────────

describe("parseSignResponse", () => {
  it("parses plain JSON and re-derives parking_type from the rules", () => {
    const data = parseSignResponse(VALID_JSON);

    expect(data.rules).toHaveLength(1);
    expect(data.parking_type).toBe("paid");
  });

  it("strips markdown code fences", () => {
    const data = parseSignResponse("```json\n" + VALID_JSON + "\n```");
    expect(data.rules).toHaveLength(1);
  });

  it.each([
    ["text that is not JSON", "Sorry, I cannot read this sign."],
    ["an empty response", ""],
    ["JSON without a rules array", JSON.stringify({ raw_text: "x" })],
    ["a JSON array", JSON.stringify([])],
    ["JSON null", "null"],
  ])("throws GeminiResponseError for %s", (_label, text) => {
    expect(() => parseSignResponse(text)).toThrow(GeminiResponseError);
  });

  it("keeps the raw model text on the error for debugging", () => {
    try {
      parseSignResponse("not json");
      throw new Error("expected parseSignResponse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiResponseError);
      expect((err as GeminiResponseError).raw).toBe("not json");
    }
  });
});

// ─── extractParkingData ───────────────────────────────────────────────────────

describe("extractParkingData", () => {
  it("calls the configured model with the configured thinking level", async () => {
    process.env.GEMINI_API_KEY = "key-extract";
    process.env.GEMINI_MODEL = "model-from-env";
    process.env.GEMINI_THINKING_LEVEL = "medium";
    sdk.responseText = VALID_JSON;

    const data = await extractParkingData("/9j/abc", "prompt");

    expect(data.parking_type).toBe("paid");
    expect(sdk.requests[0].model).toBe("model-from-env");
    expect(sdk.requests[0].config?.thinkingConfig?.thinkingLevel).toBe("MEDIUM");
  });

  it("uses the default model when GEMINI_MODEL is not set", async () => {
    process.env.GEMINI_API_KEY = "key-default";
    sdk.responseText = VALID_JSON;

    await extractParkingData("/9j/abc", "prompt");

    expect(sdk.requests[0].model).toBe(getGeminiConfig().model);
  });

  it("throws GeminiNotConfiguredError without calling the model when the key is missing", async () => {
    await expect(extractParkingData("/9j/abc", "prompt")).rejects.toBeInstanceOf(GeminiNotConfiguredError);
    expect(sdk.requests).toHaveLength(0);
  });

  it("wraps SDK failures in GeminiRequestError", async () => {
    process.env.GEMINI_API_KEY = "key-fail";
    sdk.error = new Error("model not found");

    await expect(extractParkingData("/9j/abc", "prompt")).rejects.toMatchObject({
      name: "GeminiRequestError",
      message: "model not found",
    });
  });

  it("throws GeminiResponseError when the model returns no text", async () => {
    process.env.GEMINI_API_KEY = "key-empty";
    sdk.responseText = undefined;

    await expect(extractParkingData("/9j/abc", "prompt")).rejects.toBeInstanceOf(GeminiResponseError);
  });
});

// ─── geminiErrorResponse ──────────────────────────────────────────────────────

describe("geminiErrorResponse", () => {
  it("maps a missing key to 503", () => {
    expect(geminiErrorResponse(new GeminiNotConfiguredError()).status).toBe(503);
  });

  it("maps a failed model call to 502 with the reason", () => {
    const { status, body } = geminiErrorResponse(new GeminiRequestError("quota exceeded"));

    expect(status).toBe(502);
    expect(body.error).toBe("Gemini API error: quota exceeded");
  });

  it("maps an unparseable answer to 500 and includes the raw text", () => {
    const { status, body } = geminiErrorResponse(new GeminiResponseError("oops"));

    expect(status).toBe(500);
    expect(body).toEqual({ error: "Gemini returned unparseable JSON", raw: "oops" });
  });

  it("maps anything unexpected to 502", () => {
    expect(geminiErrorResponse("boom").status).toBe(502);
  });
});
