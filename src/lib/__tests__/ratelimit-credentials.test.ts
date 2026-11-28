import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const vercel = {
  KV_REST_API_URL: "https://vercel.example.test",
  KV_REST_API_TOKEN: "vercel-test-token",
};
const legacy = {
  UPSTASH_REDIS_REST_URL: "https://legacy.example.test",
  UPSTASH_REDIS_REST_TOKEN: "legacy-test-token",
};
const readOnlyToken = "read-only-test-token";
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  for (const name of [...Object.keys(vercel), ...Object.keys(legacy)]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("KV_REST_API_READ_ONLY_TOKEN", readOnlyToken);
  vi.stubEnv("VERCEL_ENV", "production");
  fetchMock.mockReset().mockImplementation(async () => Response.json([{ result: [9, 10] }]));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function checkRateLimit(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const { enforceAiRateLimit } = await import("../ai-guard");
  const request = new NextRequest("http://localhost/api/can-i-park", { method: "POST" });
  return enforceAiRateLimit(request, "can-i-park");
}

describe("Upstash REST credentials", () => {
  it.each([
    { name: "Vercel pair alone", env: vercel, selected: "vercel" },
    { name: "Vercel pair when both are complete", env: { ...legacy, ...vercel }, selected: "vercel" },
    { name: "legacy pair alone", env: legacy, selected: "legacy" },
    {
      name: "legacy pair when the Vercel token is missing",
      env: { ...legacy, KV_REST_API_URL: vercel.KV_REST_API_URL },
      selected: "legacy",
    },
    {
      name: "legacy pair when the Vercel URL is missing",
      env: { ...legacy, KV_REST_API_TOKEN: vercel.KV_REST_API_TOKEN },
      selected: "legacy",
    },
  ])("uses the $name", async ({ env, selected }) => {
    expect(await checkRateLimit(env)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(new URL(String(url)).origin).toBe(`https://${selected}.example.test`);
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${selected}-test-token`);
    }
  });

  it.each([
    { name: "a read-only token alone", env: {} },
    { name: "a Vercel URL and a read-only token", env: { KV_REST_API_URL: vercel.KV_REST_API_URL } },
    {
      name: "a blank Vercel token",
      env: { ...vercel, KV_REST_API_TOKEN: "  " },
    },
    {
      name: "a Vercel URL with only a legacy token",
      env: { KV_REST_API_URL: vercel.KV_REST_API_URL, UPSTASH_REDIS_REST_TOKEN: legacy.UPSTASH_REDIS_REST_TOKEN },
    },
    {
      name: "a legacy URL with only a Vercel token",
      env: { UPSTASH_REDIS_REST_URL: legacy.UPSTASH_REDIS_REST_URL, KV_REST_API_TOKEN: vercel.KV_REST_API_TOKEN },
    },
  ])("fails closed for $name", async ({ env }) => {
    expect((await checkRateLimit(env))?.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Redis rejects the selected token", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "invalid token" }, { status: 401 }));

    expect((await checkRateLimit({ ...legacy, ...vercel }))?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed without logging the invalid REST URL", async () => {
    expect((await checkRateLimit({ ...vercel, KV_REST_API_URL: "invalid-rest-url" }))?.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("[rate-limit] Upstash check failed:", "can-i-park");
  });
});
