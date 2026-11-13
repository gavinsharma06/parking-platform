import { createServiceRoleClient } from "./supabase-server";
import { SIGN_IMAGE_MIME_TYPE } from "./gemini";
import type { ExtractedParkingData } from "./parking-rules";
import type { Coordinates } from "./validation";

// ─── Storing sign submissions (server only) ───────────────────────────────────
// All writes to the `parking-signs` bucket and the `sign_submissions` table go
// through here with the service role, after the calling route has rate limited
// the request and validated the image and location. Browsers never write to
// Supabase directly.

export const SIGN_BUCKET = "parking-signs";
const SIGN_FOLDER = "submissions";

/** Which flow the photo came from. */
export type SubmissionSource = "submit" | "quick_check";

export type NewSignSubmission = {
  /** Base64 JPEG, already size-checked by the route. */
  imageBase64: string;
  coordinates: Coordinates;
  source: SubmissionSource;
  userAgent: string | null;
  extractedData: ExtractedParkingData | null;
};

const MAX_USER_AGENT_LENGTH = 300;

/**
 * Uploads the photo and creates the pending submission row.
 * Throws if either step fails; the uploaded file is removed if the row cannot
 * be created, so storage never holds orphaned images.
 */
export async function saveSignSubmission(input: NewSignSubmission): Promise<{ id: string }> {
  const supabase = createServiceRoleClient();
  const storagePath = `${SIGN_FOLDER}/${Date.now()}-${crypto.randomUUID()}.jpg`;

  const { error: storageError } = await supabase.storage
    .from(SIGN_BUCKET)
    .upload(storagePath, Buffer.from(input.imageBase64, "base64"), {
      contentType: SIGN_IMAGE_MIME_TYPE,
      upsert: false,
    });

  if (storageError) throw new Error(`Image upload failed: ${storageError.message}`);

  const { data, error: dbError } = await supabase
    .from("sign_submissions")
    .insert({
      image_path: storagePath,
      latitude:   input.coordinates.latitude,
      longitude:  input.coordinates.longitude,
      // Built on the server so clients cannot store arbitrary JSON here
      device_metadata: {
        source:     input.source,
        userAgent:  input.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
        capturedAt: new Date().toISOString(),
      },
      extracted_data: input.extractedData,
    })
    .select("id")
    .single();

  if (dbError || !data) {
    await supabase.storage.from(SIGN_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(`Could not save submission: ${dbError?.message ?? "no row returned"}`);
  }

  return { id: data.id as string };
}
