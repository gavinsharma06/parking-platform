// ─── Camera capture settings (browser) ────────────────────────────────────────
// Photos are downscaled before upload so a normal capture stays far below the
// server's image size cap and the AI model is not sent more pixels than a
// parking sign needs.

/** Longest edge, in pixels, of a captured photo. */
export const CAPTURE_MAX_DIMENSION = 1280;

/** JPEG quality (0–1). Kept high: heavy compression hurts text recognition. */
export const CAPTURE_JPEG_QUALITY = 0.85;

export const CAPTURE_MIME_TYPE = "image/jpeg";

/** Scales a width/height pair down to fit `maxDimension`; never scales up. */
export function fitWithin(
  width: number,
  height: number,
  maxDimension: number = CAPTURE_MAX_DIMENSION,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension || longest === 0) return { width, height };

  const scale = maxDimension / longest;
  return {
    width:  Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** Draws the current video frame onto a canvas, downscaled to the capture size. */
export function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const { width, height } = fitWithin(video.videoWidth, video.videoHeight);

  const canvas = document.createElement("canvas");
  canvas.width  = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);

  return canvas;
}
