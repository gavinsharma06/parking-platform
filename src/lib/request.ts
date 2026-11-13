// ─── Shared request helpers for route handlers ────────────────────────────────

/** Best-effort client IP. The first x-forwarded-for entry is the client. */
export function getClientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export class PayloadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super("Request body is not valid JSON");
    this.name = "InvalidJsonError";
  }
}

/**
 * Reads and parses a JSON body while enforcing a byte limit.
 *
 * Content-Length is checked first so honest oversized requests are rejected
 * without reading anything. The stream is then read with a running total, so a
 * missing or wrong Content-Length cannot be used to push more than `maxBytes`
 * into memory.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  if (!req.body) throw new InvalidJsonError();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InvalidJsonError();
  }
}
