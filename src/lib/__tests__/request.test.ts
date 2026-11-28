import { describe, expect, it } from "vitest";

import { getClientIp, InvalidJsonError, PayloadTooLargeError, readJsonBody } from "../request";

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** A request whose body arrives in chunks with no Content-Length header. */
function streamedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return new Request("http://localhost/api/test", {
    method: "POST",
    body: stream,
    // Required by Node's fetch implementation for streamed request bodies.
    duplex: "half",
  } as RequestInit);
}

// ─── getClientIp ──────────────────────────────────────────────────────────────

describe("getClientIp", () => {
  it("returns the first x-forwarded-for entry", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(getClientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("returns 'unknown' when no header is present", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});

// ─── readJsonBody ─────────────────────────────────────────────────────────────

describe("readJsonBody", () => {
  it("parses a body within the limit", async () => {
    const body = await readJsonBody(jsonRequest('{"image":"abc"}'), 1000);
    expect(body).toEqual({ image: "abc" });
  });

  it("rejects when Content-Length declares more than the limit", async () => {
    const req = jsonRequest("{}", { "content-length": "5000000" });
    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("rejects an oversized streamed body that has no Content-Length", async () => {
    const big = "x".repeat(600);
    const req = streamedRequest([`{"image":"${big}`, `${big}"}`]);

    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("accepts a streamed body that stays within the limit", async () => {
    const req = streamedRequest(['{"image":', '"abc"}']);
    await expect(readJsonBody(req, 1000)).resolves.toEqual({ image: "abc" });
  });

  it("throws InvalidJsonError for malformed JSON", async () => {
    await expect(readJsonBody(jsonRequest("{not json"), 1000)).rejects.toBeInstanceOf(InvalidJsonError);
  });

  it("throws InvalidJsonError for an empty body", async () => {
    const req = new Request("http://localhost/api/test", { method: "POST" });
    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(InvalidJsonError);
  });
});
