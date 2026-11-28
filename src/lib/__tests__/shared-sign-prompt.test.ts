import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ fetchExamples: vi.fn(), extract: vi.fn() }));
vi.mock("@/lib/ai-guard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ai-guard")>(),
  enforceAiRateLimit: async () => null,
}));
vi.mock("@/lib/training-examples", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/training-examples")>(),
  fetchFewShotExamples: mocks.fetchExamples,
}));
vi.mock("@/lib/gemini", () => ({
  isGeminiConfigured: () => true,
  extractParkingData: mocks.extract,
  geminiErrorResponse: () => ({ status: 500, body: { error: "Extraction failed" } }),
}));

import { POST as analyseSign } from "@/app/api/analyse-sign/route";
import { POST as checkParking } from "@/app/api/can-i-park/route";

const image = "/9j/AA==";
const extraction = { raw_text: "", rules: [], confidence: 0.1 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.extract.mockResolvedValue(extraction);
  mocks.fetchExamples.mockResolvedValue([]);
});

function request(route: string) {
  return new NextRequest(`http://localhost/api/${route}`, {
    method: "POST",
    body: JSON.stringify({ image }),
  });
}

describe("shared sign prompt", () => {
  it("uses the same prompt and approved examples for both photo routes", async () => {
    mocks.fetchExamples.mockResolvedValue([{ raw_text: "THURSDAY STREET CLEANING", approved_extracted_data: extraction }]);

    expect((await analyseSign(request("analyse-sign"))).status).toBe(200);
    expect((await checkParking(request("can-i-park"))).status).toBe(200);
    expect(mocks.fetchExamples.mock.calls).toEqual([[5], [5]]);
    expect(mocks.extract.mock.calls[0]).toEqual(mocks.extract.mock.calls[1]);
    expect(mocks.extract.mock.calls[0][1]).toContain("THURSDAY STREET CLEANING");
  });

  it("can still check a photo when there are no approved examples", async () => {
    expect((await checkParking(request("can-i-park"))).status).toBe(200);
    expect(mocks.extract).toHaveBeenCalledWith(image, expect.stringContaining("Return a JSON object"));
    expect(mocks.extract.mock.calls[0][1]).not.toContain("<examples>");
  });
});
