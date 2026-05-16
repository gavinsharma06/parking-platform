"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uploadSignSubmission } from "@/lib/submissions";
import { RULE_TYPE_COLOR, RULE_TYPE_LABEL, formatTimeWindow, formatDays } from "@/lib/parking-rules";
import type { ExtractedParkingData, ParkingRule } from "@/lib/parking-rules";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status =
  | "idle"
  | "camera"
  | "locating"
  | "ready"
  | "analysing"
  | "submitting"
  | "success";

interface Photo {
  blob: Blob;
  previewUrl: string;
  base64: string;
}

interface Location {
  lat: number;
  lng: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAnalysis(base64: string): Promise<ExtractedParkingData> {
  const res = await fetch("/api/analyse-sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64 }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Server error ${res.status}`);
  }
  return res.json();
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SignCapture() {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status,    setStatus]    = useState<Status>("idle");
  const [photo,     setPhoto]     = useState<Photo | null>(null);
  const [location,  setLocation]  = useState<Location | null>(null);
  const [extracted, setExtracted] = useState<ExtractedParkingData | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => () => stopStream(), []);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // ── Step 1: open camera ───────────────────────────────────────────────────

  const openCamera = useCallback(async () => {
    setError(null);
    setStatus("camera");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("insecure-context");
      }
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
          ? "Camera requires a secure connection (HTTPS). Open this page using the https:// address shown in the server terminal."
          : name === "NotAllowedError"
            ? "Camera permission denied. Tap Allow in your browser's permission prompt, then try again."
            : "Could not start camera. Make sure no other app is using it.",
      );
    }
  }, []);

  // ── Step 2: capture photo + get location ──────────────────────────────────

  const captureAndLocate = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    const canvas = document.createElement("canvas");
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    stopStream();

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) { setError("Failed to capture photo. Please try again."); setStatus("idle"); return; }

    const base64     = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    const previewUrl = URL.createObjectURL(blob);

    setPhoto({ blob, previewUrl, base64 });
    setStatus("locating");
    setError(null);

    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, {
          enableHighAccuracy: true,
          timeout: 15_000,
          maximumAge: 0,
        }),
      );
      setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setStatus("ready");
    } catch (e) {
      URL.revokeObjectURL(previewUrl);
      setPhoto(null);
      setStatus("idle");
      setError(
        e instanceof GeolocationPositionError && e.code === 1
          ? "Location permission denied. We need your position to pin the sign. Allow location access and try again."
          : "Could not get your location. Make sure location services are enabled, then try again.",
      );
    }
  }, []);

  // ── Step 3: retake ────────────────────────────────────────────────────────

  const retake = useCallback(() => {
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null); setLocation(null); setExtracted(null); setError(null);
    openCamera();
  }, [photo, openCamera]);

  // ── Step 4: submit — analyses then uploads in one action ──────────────────

  const submit = useCallback(async () => {
    if (!photo || !location) return;
    setError(null);

    // Analyse first
    setStatus("analysing");
    let analysedData: ExtractedParkingData | null = null;
    try {
      analysedData = await fetchAnalysis(photo.base64);
      setExtracted(analysedData);
    } catch {
      // Analysis failed — proceed without OCR data
    }

    // Upload
    setStatus("submitting");
    try {
      await uploadSignSubmission({
        imageBlob:  photo.blob,
        latitude:   location.lat,
        longitude:  location.lng,
        deviceMetadata: { userAgent: navigator.userAgent, capturedAt: new Date().toISOString() },
        extractedData: analysedData ?? undefined,
      });
      URL.revokeObjectURL(photo.previewUrl);
      setPhoto(null);
      setLocation(null);
      // Keep `extracted` — success screen shows it
      setStatus("success");
    } catch {
      setStatus("ready");
      setError("Upload failed. Check your connection and try again.");
    }
  }, [photo, location]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null); setLocation(null); setExtracted(null); setError(null); setStatus("idle");
  }, [photo]);

  // ─── Success screen ───────────────────────────────────────────────────────

  if (status === "success") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-green-100 bg-green-50 p-8 text-center">
        <span className="text-4xl">✅</span>
        <div>
          <h2 className="text-lg font-bold text-gray-900">Submission received</h2>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            Thanks! Your photo is under review and will appear on the map once approved.
          </p>
        </div>

        {extracted && extracted.rules.length > 0 && (
          <div className="w-full space-y-2 text-left">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              What we found
            </p>
            {extracted.rules.map((rule: ParkingRule, i: number) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-xl border border-gray-100 bg-white px-3 py-2.5"
              >
                <span
                  className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: RULE_TYPE_COLOR[rule.rule_type] }}
                />
                <div>
                  <p className="text-sm font-semibold text-gray-800">
                    {RULE_TYPE_LABEL[rule.rule_type]}
                    {rule.tow_away && " — Tow away zone"}
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
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={reset}
          className="mt-2 rounded-full bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Submit another
        </button>
      </div>
    );
  }

  const showPreview = photo && ["locating", "ready", "analysing", "submitting"].includes(status);

  return (
    <div className="flex flex-col gap-5">

      {/* ── Viewport ──────────────────────────────────────────────────────── */}
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

        {showPreview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.previewUrl} alt="Captured sign" className="h-full w-full object-cover" />
        )}

        {status === "idle" && (
          <div className="flex h-full items-center justify-center text-gray-500">
            <div className="text-center">
              <div className="text-5xl">📷</div>
              <p className="mt-3 text-sm">Camera preview will appear here</p>
            </div>
          </div>
        )}

        {status === "locating"   && <Overlay label="Getting your location…" />}
        {status === "analysing"  && <Overlay label="Reading the sign…" />}
        {status === "submitting" && <Overlay label="Uploading…" />}
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Location confirmation ──────────────────────────────────────────── */}
      {status === "ready" && location && (
        <p className="text-center text-xs text-green-700">
          Location captured — {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
        </p>
      )}

      {/* ── Action buttons ─────────────────────────────────────────────────── */}
      {status === "idle" && (
        <button
          onClick={openCamera}
          className="w-full rounded-full bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          Open Camera
        </button>
      )}

      {status === "camera" && (
        <button
          onClick={captureAndLocate}
          className="w-full rounded-full bg-green-600 py-3 text-sm font-semibold text-white hover:bg-green-700"
        >
          Capture Sign
        </button>
      )}

      {status === "ready" && (
        <div className="flex gap-3">
          <button
            onClick={retake}
            className="flex-1 rounded-full border border-gray-300 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Retake
          </button>
          <button
            onClick={submit}
            className="flex-2 rounded-full bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Submit
          </button>
        </div>
      )}

      {(status === "locating" || status === "analysing" || status === "submitting") && (
        <button disabled className="w-full cursor-not-allowed rounded-full bg-indigo-400 py-3 text-sm font-semibold text-white">
          {status === "locating" ? "Getting location…" : status === "analysing" ? "Reading sign…" : "Uploading…"}
        </button>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Overlay({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
      <div className="rounded-xl bg-white px-5 py-3 text-sm font-medium text-gray-800 shadow-lg">
        {label}
      </div>
    </div>
  );
}
