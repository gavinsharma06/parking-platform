import { supabase } from "./supabase";
import { isHalifaxLocation } from "./validation";
import type { ExtractedParkingData } from "@/app/api/analyse-sign/route";

export async function uploadSignSubmission({
  imageBlob,
  latitude,
  longitude,
  deviceMetadata,
  extractedData,
}: {
  imageBlob: Blob;
  latitude: number;
  longitude: number;
  deviceMetadata: Record<string, string>;
  extractedData?: ExtractedParkingData;
}): Promise<void> {
  // Reject submissions outside Halifax/HRM bounds immediately
  if (!isHalifaxLocation(latitude, longitude)) {
    throw new Error("Location is outside the Halifax Regional Municipality area.");
  }

  const storagePath = `submissions/${Date.now()}-${crypto.randomUUID()}.jpg`;

  const { error: storageError } = await supabase.storage
    .from("parking-signs")
    .upload(storagePath, imageBlob, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (storageError) throw storageError;

  const { error: dbError } = await supabase.from("sign_submissions").insert({
    image_path: storagePath,
    latitude,
    longitude,
    device_metadata: deviceMetadata,
    extracted_data: extractedData ?? null,
  });

  if (dbError) {
    await supabase.storage.from("parking-signs").remove([storagePath]).catch(() => {});
    throw dbError;
  }
}
