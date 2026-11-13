import { NextRequest, NextResponse } from "next/server";

import { enforceAiRateLimit, readImageRequest } from "@/lib/ai-guard";
import { extractParkingData, isGeminiConfigured } from "@/lib/gemini";
import { saveSignSubmission } from "@/lib/sign-submissions";
import { buildPrompt, fetchFewShotExamples } from "@/lib/training-examples";
import { isHalifaxLocation, OUTSIDE_SERVICE_AREA_MESSAGE, parseCoordinates } from "@/lib/validation";
import type { ExtractedParkingData } from "@/lib/parking-rules";

const FEW_SHOT_EXAMPLES = 5;

// POST /api/submissions — submit a sign photo for admin review.
//
// Body: { image: <base64 JPEG or data URI>, latitude: number, longitude: number }
//
// Gate order: rate limit → body and image size → location → AI call → storage.
// Nothing that costs money or disk runs for a request that fails an earlier gate.
// The sign is read here, on the server, so the stored rules are never supplied
// by the client.
export async function POST(req: NextRequest) {
  const limited = await enforceAiRateLimit(req, "submit");
  if (limited) return limited;

  const payload = await readImageRequest(req);
  if (!payload.ok) return payload.response;

  const coordinates = parseCoordinates(payload.body.latitude, payload.body.longitude);
  if (!coordinates) {
    return NextResponse.json(
      { error: "Body must include numeric `latitude` and `longitude`." },
      { status: 400 },
    );
  }
  if (!isHalifaxLocation(coordinates.latitude, coordinates.longitude)) {
    return NextResponse.json({ error: OUTSIDE_SERVICE_AREA_MESSAGE }, { status: 422 });
  }

  // Reading the sign is best effort: if it fails, the photo is still saved and
  // an admin reviews it by hand.
  let extractedData: ExtractedParkingData | null = null;
  if (isGeminiConfigured()) {
    try {
      const prompt = buildPrompt(await fetchFewShotExamples(FEW_SHOT_EXAMPLES));
      extractedData = await extractParkingData(payload.imageBase64, prompt);
    } catch (err) {
      console.error("[submissions] sign analysis failed:", err instanceof Error ? err.name : err);
    }
  }

  try {
    const { id } = await saveSignSubmission({
      imageBase64: payload.imageBase64,
      coordinates,
      source:      "submit",
      userAgent:   req.headers.get("user-agent"),
      extractedData,
    });
    return NextResponse.json({ ok: true, id, extracted_data: extractedData }, { status: 201 });
  } catch (err) {
    console.error("[submissions] save failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Could not save your submission. Please try again." },
      { status: 500 },
    );
  }
}
