"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RULE_TYPE_COLOR, RULE_TYPE_LABEL, formatTimeWindow, formatDays } from "@/lib/parking-rules";
import type { ParkingRule } from "@/lib/parking-rules";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "idle" | "camera" | "checking" | "result";

interface Result {
  answer: string;
  can_park: boolean | null;
  rules: ParkingRule[];
  confidence: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLocation(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      ()    => resolve(null),   // silently resolve null on deny/timeout
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 0 },
    );
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ParkingCheck() {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status,  setStatus]  = useState<Status>("idle");
  const [result,  setResult]  = useState<Result | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saved,   setSaved]   = useState(false);   // whether it reached sign_submissions
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => () => stopStream(), []);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // ── Open camera ───────────────────────────────────────────────────────────

  const openCamera = useCallback(async () => {
    setError(null);
    setResult(null);
    setSaved(false);
    setStatus("camera");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("insecure-context");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (e) {
      setStatus("idle");
      const name = e instanceof DOMException ? e.name : (e instanceof Error ? e.message : "");
      setError(
        name === "insecure-context"
          ? "Camera requires HTTPS. Open the page via the https:// address."
          : name === "NotAllowedError"
            ? "Camera permission denied. Tap Allow and try again."
            : "Could not start camera.",
      );
    }
  }, []);

  // ── Capture → analyse + get location in parallel ──────────────────────────

  const captureAndCheck = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    const canvas = document.createElement("canvas");
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    stopStream();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setPreview(dataUrl);
    setStatus("checking");
    setError(null);

    try {
      // Get location first (~1s), then call API with both image + coords.
      // Gemini dominates latency (~4s) so the sequential overhead is negligible.
      const location = await getLocation();

      const res = await fetch("/api/can-i-park", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ image: dataUrl, ...(location ?? {}) }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);

      setResult(data as Result);
      setSaved(location !== null);
      setStatus("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setStatus("idle");
      setPreview(null);
    }
  }, []);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setPreview(null);
    setSaved(false);
    setError(null);
  }, []);

  // ─── Result screen ────────────────────────────────────────────────────────

  if (status === "result" && result) {
    const isYes = result.can_park === true;
    const isNo  = result.can_park === false;

    return (
      <div className="flex flex-col gap-5">
        {/* Answer card */}
        <div className={`rounded-2xl p-6 text-center ${
          isYes ? "bg-green-50 border border-green-200"
          : isNo ? "bg-red-50 border border-red-200"
          : "bg-yellow-50 border border-yellow-200"
        }`}>
          <div className="text-4xl mb-3">
            {isYes ? "✅" : isNo ? "🚫" : "⚠️"}
          </div>
          <p className={`text-lg font-bold leading-snug ${
            isYes ? "text-green-800" : isNo ? "text-red-800" : "text-yellow-800"
          }`}>
            {result.answer}
          </p>
          {result.confidence < 0.5 && (
            <p className="mt-2 text-xs text-gray-500">
              Low confidence — sign may be partially obscured. Verify in person.
            </p>
          )}
        </div>

        {/* Sign photo */}
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="Captured sign"
            className="w-full rounded-2xl object-cover border border-gray-100"
            style={{ maxHeight: 220 }}
          />
        )}

        {/* Contribution note */}
        <p className="text-center text-xs text-gray-400">
          {saved
            ? "Your photo was saved and will help improve the parking map."
            : "Location unavailable — answer shown but photo not saved to map."}
        </p>

        {/* Rules breakdown */}
        {result.rules.length > 0 && (
          <details className="rounded-2xl border border-gray-200 bg-white">
            <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold text-gray-700 select-none">
              Sign details ({result.rules.length} rule{result.rules.length !== 1 ? "s" : ""})
            </summary>
            <div className="space-y-2 px-5 pb-4">
              {result.rules.map((rule: ParkingRule, i: number) => (
                <div key={i} className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5">
                  <span
                    className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: RULE_TYPE_COLOR[rule.rule_type] }}
                  />
                  <div>
                    <p className="text-sm font-semibold text-gray-800">
                      {RULE_TYPE_LABEL[rule.rule_type]}
                      {rule.tow_away && " — Tow away"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {[
                        rule.direction === "left"  ? "← Left"  : null,
                        rule.direction === "right" ? "→ Right" : null,
                        rule.time_window ? formatTimeWindow(rule.time_window) : "24/7",
                        rule.days !== null ? formatDays(rule.days) : "Every day",
                        rule.time_limit_minutes
                          ? `${Math.floor(rule.time_limit_minutes / 60)}h${rule.time_limit_minutes % 60 > 0 ? ` ${rule.time_limit_minutes % 60}m` : ""} max`
                          : null,
                        rule.cost_per_hour != null ? `$${rule.cost_per_hour.toFixed(2)}/hr` : null,
                        rule.permit_zone ? `Zone ${rule.permit_zone}` : null,
                      ].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        <button
          onClick={reset}
          className="w-full rounded-full bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Check another sign
        </button>
      </div>
    );
  }

  // ─── Camera / idle screen ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">
      <div
        className="relative overflow-hidden rounded-2xl border border-gray-200 bg-gray-950"
        style={{ aspectRatio: "4/3" }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${status === "camera" ? "" : "hidden"}`}
        />

        {status === "checking" && preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Captured sign" className="h-full w-full object-cover" />
        )}

        {status === "idle" && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-gray-500">
              <div className="text-6xl">🅿️</div>
              <p className="mt-3 text-sm">Point your camera at a parking sign</p>
            </div>
          </div>
        )}

        {status === "checking" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="rounded-xl bg-white px-5 py-3 text-sm font-medium text-gray-800 shadow-lg">
              Reading sign…
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {status === "idle" && (
        <button
          onClick={openCamera}
          className="w-full rounded-full bg-green-600 py-3.5 text-sm font-semibold text-white hover:bg-green-700"
        >
          Open Camera
        </button>
      )}

      {status === "camera" && (
        <button
          onClick={captureAndCheck}
          className="w-full rounded-full bg-green-600 py-3.5 text-base font-bold text-white hover:bg-green-700"
        >
          Check This Sign
        </button>
      )}

      {status === "checking" && (
        <button disabled className="w-full cursor-not-allowed rounded-full bg-green-400 py-3.5 text-sm font-semibold text-white">
          Analysing…
        </button>
      )}
    </div>
  );
}
