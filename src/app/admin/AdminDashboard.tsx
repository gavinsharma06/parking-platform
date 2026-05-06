"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";

type ExtractedData = {
  parking_type?: string;
  time_limit_minutes?: number | null;
  cost_per_hour?: number | null;
  schedule?: string | null;
  raw_text?: string;
};

type Submission = {
  id: string;
  image_path: string;
  image_url: string | null;
  latitude: number;
  longitude: number;
  extracted_data: ExtractedData | null;
  status: "pending_review" | "approved" | "rejected";
  reviewer_notes: string | null;
  submitted_at: string;
  parking_spot_id: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  pending_review: "bg-yellow-100 text-yellow-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
};

const PARKING_TYPE_COLOUR: Record<string, string> = {
  free: "text-green-700",
  paid: "text-blue-700",
  permit: "text-orange-700",
  accessible: "text-purple-700",
  unknown: "text-gray-500",
};

export default function AdminDashboard() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending_review" | "approved" | "rejected">("pending_review");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/submissions");
      if (!res.ok) throw new Error(await res.text());
      const data: Submission[] = await res.json();
      setSubmissions(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load submissions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: "approve" | "reject") {
    setActing(id);
    try {
      const res = await fetch(`/api/admin/submissions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reviewer_notes: notes[id] ?? "" }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Request failed");
      }
      await load();
      setExpanded(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  const visible = filter === "all"
    ? submissions
    : submissions.filter((s) => s.status === filter);

  const counts = {
    all: submissions.length,
    pending_review: submissions.filter((s) => s.status === "pending_review").length,
    approved: submissions.filter((s) => s.status === "approved").length,
    rejected: submissions.filter((s) => s.status === "rejected").length,
  };

  return (
    <div>
      {/* Filter tabs */}
      <div className="mb-6 flex gap-2 flex-wrap">
        {(["pending_review", "all", "approved", "rejected"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === f
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {f === "pending_review" ? "Pending" : f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-1.5 rounded-full bg-white/20 px-1.5 py-0.5 text-xs">
              {counts[f]}
            </span>
          </button>
        ))}
        <button
          onClick={load}
          className="ml-auto rounded-full border border-gray-200 px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-gray-400">Loading submissions…</div>
      ) : visible.length === 0 ? (
        <div className="py-20 text-center text-gray-400">
          No {filter === "all" ? "" : filter.replace("_", " ")} submissions.
        </div>
      ) : (
        <div className="space-y-4">
          {visible.map((sub) => {
            const isOpen = expanded === sub.id;
            const ext = sub.extracted_data;
            const mapsUrl = `https://www.google.com/maps?q=${sub.latitude},${sub.longitude}`;

            return (
              <div
                key={sub.id}
                className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
              >
                {/* Card header */}
                <button
                  className="w-full text-left px-5 py-4 flex items-start gap-4 hover:bg-gray-50 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : sub.id)}
                >
                  {/* Thumbnail */}
                  <div className="h-16 w-16 flex-shrink-0 rounded-lg overflow-hidden bg-gray-100">
                    {sub.image_url ? (
                      <Image
                        src={sub.image_url}
                        alt="Parking sign"
                        width={64}
                        height={64}
                        className="h-full w-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-gray-300 text-2xl">
                        📷
                      </div>
                    )}
                  </div>

                  {/* Summary */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[sub.status]}`}
                      >
                        {sub.status.replace("_", " ")}
                      </span>
                      {ext?.parking_type && (
                        <span
                          className={`text-sm font-semibold ${PARKING_TYPE_COLOUR[ext.parking_type] ?? "text-gray-600"}`}
                        >
                          {ext.parking_type}
                        </span>
                      )}
                      {ext?.time_limit_minutes && (
                        <span className="text-xs text-gray-500">
                          {ext.time_limit_minutes} min
                        </span>
                      )}
                      {ext?.cost_per_hour != null && ext.cost_per_hour > 0 && (
                        <span className="text-xs text-gray-500">
                          ${ext.cost_per_hour}/hr
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-gray-400 truncate">
                      {sub.latitude.toFixed(6)}, {sub.longitude.toFixed(6)} ·{" "}
                      {new Date(sub.submitted_at).toLocaleString()}
                    </p>
                  </div>

                  <span className="text-gray-400 text-sm">{isOpen ? "▲" : "▼"}</span>
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="border-t border-gray-100 px-5 py-5 space-y-5">
                    <div className="grid gap-5 sm:grid-cols-2">
                      {/* Photo */}
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                          Photo
                        </p>
                        {sub.image_url ? (
                          <a href={sub.image_url} target="_blank" rel="noreferrer">
                            <Image
                              src={sub.image_url}
                              alt="Parking sign"
                              width={400}
                              height={300}
                              className="w-full rounded-xl object-contain bg-gray-50 border border-gray-100"
                              unoptimized
                            />
                          </a>
                        ) : (
                          <div className="flex h-40 items-center justify-center rounded-xl bg-gray-50 text-sm text-gray-400">
                            No image available
                          </div>
                        )}
                      </div>

                      {/* Data */}
                      <div className="space-y-4">
                        {/* GPS */}
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                            Location
                          </p>
                          <p className="text-sm text-gray-700">
                            {sub.latitude.toFixed(6)}, {sub.longitude.toFixed(6)}
                          </p>
                          <a
                            href={mapsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-block text-xs text-indigo-600 hover:underline"
                          >
                            Open in Google Maps ↗
                          </a>
                        </div>

                        {/* Extracted */}
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                            Extracted Data
                          </p>
                          {ext ? (
                            <table className="w-full text-sm">
                              <tbody className="divide-y divide-gray-100">
                                {[
                                  ["Type", ext.parking_type ?? "—"],
                                  ["Time limit", ext.time_limit_minutes ? `${ext.time_limit_minutes} min` : "—"],
                                  ["Cost", ext.cost_per_hour != null ? `$${ext.cost_per_hour}/hr` : "—"],
                                  ["Schedule", ext.schedule ?? "—"],
                                ].map(([label, value]) => (
                                  <tr key={label}>
                                    <td className="py-1 pr-3 text-gray-400 w-24">{label}</td>
                                    <td className="py-1 text-gray-700">{value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <p className="text-sm text-gray-400">No OCR data — manual review needed</p>
                          )}
                        </div>

                        {/* Raw text */}
                        {ext?.raw_text && (
                          <div>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                              Raw OCR Text
                            </p>
                            <pre className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 whitespace-pre-wrap font-mono">
                              {ext.raw_text}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions (only for pending) */}
                    {sub.status === "pending_review" && (
                      <div className="border-t border-gray-100 pt-4 space-y-3">
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                            Reviewer Notes (optional)
                          </label>
                          <textarea
                            rows={2}
                            value={notes[sub.id] ?? ""}
                            onChange={(e) =>
                              setNotes((prev) => ({ ...prev, [sub.id]: e.target.value }))
                            }
                            placeholder="Add any notes before approving or rejecting…"
                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none"
                          />
                        </div>
                        <div className="flex gap-3">
                          <button
                            disabled={acting === sub.id}
                            onClick={() => act(sub.id, "approve")}
                            className="flex-1 rounded-xl bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                          >
                            {acting === sub.id ? "Saving…" : "Approve & Add to Map"}
                          </button>
                          <button
                            disabled={acting === sub.id}
                            onClick={() => act(sub.id, "reject")}
                            className="flex-1 rounded-xl border border-red-200 bg-red-50 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
                          >
                            {acting === sub.id ? "Saving…" : "Reject"}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Already reviewed */}
                    {sub.status !== "pending_review" && sub.reviewer_notes && (
                      <div className="border-t border-gray-100 pt-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                          Reviewer Notes
                        </p>
                        <p className="mt-1 text-sm text-gray-600">{sub.reviewer_notes}</p>
                      </div>
                    )}
                    {sub.status === "approved" && sub.parking_spot_id && (
                      <p className="text-xs text-gray-400">
                        Spot ID: <code className="font-mono">{sub.parking_spot_id}</code>
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
