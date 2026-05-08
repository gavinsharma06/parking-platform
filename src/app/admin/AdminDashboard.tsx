"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import { ruleLabel, RULE_TYPE_COLOR, RULE_TYPE_LABEL } from "@/lib/parking-rules";
import type { ExtractedParkingData, ParkingRule } from "@/lib/parking-rules";

type Submission = {
  id: string;
  image_path: string;
  image_url: string | null;
  latitude: number;
  longitude: number;
  extracted_data: ExtractedParkingData | null;
  status: "pending_review" | "approved" | "rejected";
  reviewer_notes: string | null;
  submitted_at: string;
  parking_spot_id: string | null;
};

type ParkingSpot = {
  id: string;
  latitude: number;
  longitude: number;
  parking_type: "free" | "paid" | "permit" | "accessible" | "unknown";
  street_name: string | null;
  from_street: string | null;
  to_street: string | null;
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  notes: string | null;
  source_type: string | null;
  confidence_score: number | null;
  created_at: string;
};

type EditDraft = Partial<Omit<ParkingSpot, "id" | "latitude" | "longitude" | "created_at" | "source_type" | "confidence_score">>;

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  pending_review: "bg-yellow-100 text-yellow-800",
  approved:       "bg-green-100 text-green-800",
  rejected:       "bg-red-100 text-red-800",
};

const SPOT_TYPE_DOT: Record<string, string> = {
  free:       "bg-green-500",
  paid:       "bg-blue-600",
  permit:     "bg-amber-500",
  accessible: "bg-sky-500",
  unknown:    "bg-gray-400",
};

const PARKING_TYPES = ["free", "paid", "permit", "accessible", "unknown"] as const;

// ─── Submissions tab ──────────────────────────────────────────────────────────

function SubmissionsTab() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [filter, setFilter] = useState<"all" | "pending_review" | "approved" | "rejected">("pending_review");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes,    setNotes]    = useState<Record<string, string>>({});
  const [acting,   setActing]   = useState<string | null>(null);
  const [error,    setError]    = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/submissions");
      if (!res.ok) throw new Error(await res.text());
      setSubmissions(await res.json());
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
      const result = await res.json();
      if (result.merged) {
        alert(`Approved and merged into existing nearby spot (${result.parking_spot_id})`);
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
    all:            submissions.length,
    pending_review: submissions.filter((s) => s.status === "pending_review").length,
    approved:       submissions.filter((s) => s.status === "approved").length,
    rejected:       submissions.filter((s) => s.status === "rejected").length,
  };

  return (
    <div>
      <div className="mb-6 flex gap-2 flex-wrap">
        {(["pending_review", "all", "approved", "rejected"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === f ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {f === "pending_review" ? "Pending" : f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-1.5 rounded-full bg-white/20 px-1.5 py-0.5 text-xs">{counts[f]}</span>
          </button>
        ))}
        <button onClick={load} className="ml-auto rounded-full border border-gray-200 px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50">
          Refresh
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="py-20 text-center text-gray-400">Loading submissions…</div>
      ) : visible.length === 0 ? (
        <div className="py-20 text-center text-gray-400">No {filter === "all" ? "" : filter.replace("_", " ")} submissions.</div>
      ) : (
        <div className="space-y-4">
          {visible.map((sub) => {
            const isOpen  = expanded === sub.id;
            const rules: ParkingRule[] = sub.extracted_data?.rules ?? [];
            const mapsUrl = `https://www.google.com/maps?q=${sub.latitude},${sub.longitude}`;

            // Summary chips from first rule
            const firstRule = rules[0];

            return (
              <div key={sub.id} className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <button
                  className="w-full text-left px-5 py-4 flex items-start gap-4 hover:bg-gray-50 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : sub.id)}
                >
                  <div className="h-16 w-16 flex-shrink-0 rounded-lg overflow-hidden bg-gray-100">
                    {sub.image_url ? (
                      <Image src={sub.image_url} alt="Parking sign" width={64} height={64} className="h-full w-full object-cover" unoptimized />
                    ) : (
                      <div className="flex h-full items-center justify-center text-gray-300 text-2xl">📷</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[sub.status]}`}>
                        {sub.status.replace("_", " ")}
                      </span>
                      {rules.length > 0 ? (
                        rules.slice(0, 3).map((r, i) => (
                          <span
                            key={i}
                            className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                            style={{ background: RULE_TYPE_COLOR[r.rule_type] }}
                          >
                            {RULE_TYPE_LABEL[r.rule_type]}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-gray-400">No OCR data</span>
                      )}
                      {rules.length > 3 && (
                        <span className="text-xs text-gray-400">+{rules.length - 3} more</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-gray-400 truncate">
                      {sub.latitude.toFixed(6)}, {sub.longitude.toFixed(6)} · {new Date(sub.submitted_at).toLocaleString()}
                    </p>
                    {firstRule?.time_window && (
                      <p className="text-xs text-gray-500 truncate">
                        {firstRule.time_window.start}–{firstRule.time_window.end}
                        {firstRule.days ? ` · ${firstRule.days.map((d) => ["Su","Mo","Tu","We","Th","Fr","Sa"][d]).join(",")}` : ""}
                      </p>
                    )}
                  </div>
                  <span className="text-gray-400 text-sm">{isOpen ? "▲" : "▼"}</span>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-100 px-5 py-5 space-y-5">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">Photo</p>
                        {sub.image_url ? (
                          <a href={sub.image_url} target="_blank" rel="noreferrer">
                            <Image src={sub.image_url} alt="Parking sign" width={400} height={300} className="w-full rounded-xl object-contain bg-gray-50 border border-gray-100" unoptimized />
                          </a>
                        ) : (
                          <div className="flex h-40 items-center justify-center rounded-xl bg-gray-50 text-sm text-gray-400">No image available</div>
                        )}
                      </div>
                      <div className="space-y-4">
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">Location</p>
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

                        {/* Structured rules */}
                        {rules.length > 0 ? (
                          <div>
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                              Extracted Rules ({rules.length} sign{rules.length !== 1 ? "s" : ""} detected)
                            </p>
                            <div className="space-y-2">
                              {rules.map((rule, i) => (
                                <div key={i} className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2">
                                  <span
                                    className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{ background: RULE_TYPE_COLOR[rule.rule_type] }}
                                  />
                                  <div>
                                    <p className="text-xs font-semibold text-gray-800">
                                      {RULE_TYPE_LABEL[rule.rule_type]}
                                      {rule.tow_away && " (tow-away)"}
                                    </p>
                                    <p className="text-xs text-gray-500">{ruleLabel(rule)}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400">No OCR data — manual review needed</p>
                        )}

                        {/* Raw OCR text */}
                        {sub.extracted_data?.raw_text && (
                          <details className="rounded-lg border border-gray-100">
                            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-600">
                              Raw OCR text
                            </summary>
                            <pre className="px-3 pb-3 text-xs text-gray-500 whitespace-pre-wrap font-mono">
                              {sub.extracted_data.raw_text}
                            </pre>
                          </details>
                        )}

                        {/* Confidence */}
                        {sub.extracted_data?.confidence != null && (
                          <p className="text-xs text-gray-400">
                            Parser confidence: {Math.round(sub.extracted_data.confidence * 100)}%
                          </p>
                        )}
                      </div>
                    </div>
                    {sub.status === "pending_review" && (
                      <div className="border-t border-gray-100 pt-4 space-y-3">
                        <div>
                          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Reviewer Notes (optional)</label>
                          <textarea
                            rows={2}
                            value={notes[sub.id] ?? ""}
                            onChange={(e) => setNotes((prev) => ({ ...prev, [sub.id]: e.target.value }))}
                            placeholder="Notes before approving or rejecting…"
                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none"
                          />
                        </div>
                        <div className="flex gap-3">
                          <button disabled={acting === sub.id} onClick={() => act(sub.id, "approve")} className="flex-1 rounded-xl bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50 transition-colors">
                            {acting === sub.id ? "Saving…" : "Approve & Add to Map"}
                          </button>
                          <button disabled={acting === sub.id} onClick={() => act(sub.id, "reject")} className="flex-1 rounded-xl border border-red-200 bg-red-50 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors">
                            {acting === sub.id ? "Saving…" : "Reject"}
                          </button>
                        </div>
                      </div>
                    )}

                    {sub.status !== "pending_review" && sub.reviewer_notes && (
                      <div className="border-t border-gray-100 pt-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Reviewer Notes</p>
                        <p className="mt-1 text-sm text-gray-600">{sub.reviewer_notes}</p>
                      </div>
                    )}
                    {sub.status === "approved" && sub.parking_spot_id && (
                      <p className="text-xs text-gray-400">Spot ID: <code className="font-mono">{sub.parking_spot_id}</code></p>
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

// ─── Spot editor row ──────────────────────────────────────────────────────────

function SpotRow({ spot, onSaved, onDeleted }: { spot: ParkingSpot; onSaved: () => void; onDeleted: () => void }) {
  const [editing, setEditing]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [draft, setDraft]           = useState<EditDraft>({});
  const [error, setError]           = useState<string | null>(null);

  function startEdit() {
    setDraft({
      parking_type:       spot.parking_type,
      street_name:        spot.street_name ?? "",
      from_street:        spot.from_street ?? "",
      to_street:          spot.to_street ?? "",
      time_limit_minutes: spot.time_limit_minutes ?? undefined,
      cost_per_hour:      spot.cost_per_hour ?? undefined,
      notes:              spot.notes ?? "",
    });
    setEditing(true);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/spots/${spot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSpot() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/spots/${spot.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const msg = body.error ?? "Delete failed";
        console.error("[deleteSpot] server error:", msg);
        throw new Error(msg);
      }
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setDeleting(false);
      // keep confirmDel open so the error is visible
    }
  }

  const mapsUrl = `https://www.google.com/maps?q=${spot.latitude},${spot.longitude}`;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <span className={`h-3 w-3 flex-shrink-0 rounded-full ${SPOT_TYPE_DOT[spot.parking_type] ?? "bg-gray-400"}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800 truncate">
            {spot.street_name ?? "Unknown street"}
            {spot.from_street && spot.to_street && (
              <span className="font-normal text-gray-400"> · {spot.from_street} → {spot.to_street}</span>
            )}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {spot.parking_type}
            {spot.time_limit_minutes ? ` · ${spot.time_limit_minutes} min` : ""}
            {spot.cost_per_hour != null ? ` · $${spot.cost_per_hour}/hr` : ""}{" · "}
            <a href={mapsUrl} target="_blank" rel="noreferrer" className="text-indigo-500 hover:underline">
              {spot.latitude.toFixed(5)}, {spot.longitude.toFixed(5)} ↗
            </a>
          </p>
        </div>
        {!editing && !confirmDel && (
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={startEdit} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors">
              Edit
            </button>
            <button onClick={() => setConfirmDel(true)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors">
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {confirmDel && (
        <div className="border-t border-red-100 bg-red-50 px-5 py-4">
          <p className="text-sm font-semibold text-red-800 mb-1">Delete this marker?</p>
          <p className="text-xs text-red-600 mb-3">
            Removes it from the map immediately. Any linked submissions are reset to pending review — no data is lost.
          </p>
          {error && <p className="mb-2 text-xs text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button disabled={deleting} onClick={deleteSpot} className="rounded-lg bg-red-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors">
              {deleting ? "Deleting…" : "Yes, delete"}
            </button>
            <button disabled={deleting} onClick={() => { setConfirmDel(false); setError(null); }} className="rounded-lg border border-gray-200 px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="border-t border-gray-100 px-5 py-5 space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Edit Spot</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-gray-500">Parking type</label>
              <select
                value={draft.parking_type ?? spot.parking_type}
                onChange={(e) => setDraft((d) => ({ ...d, parking_type: e.target.value as ParkingSpot["parking_type"] }))}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-indigo-400 focus:outline-none"
              >
                {PARKING_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Street name</label>
              <input type="text" value={draft.street_name ?? ""} onChange={(e) => setDraft((d) => ({ ...d, street_name: e.target.value }))} placeholder="e.g. Spring Garden Rd" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">From street</label>
              <input type="text" value={draft.from_street ?? ""} onChange={(e) => setDraft((d) => ({ ...d, from_street: e.target.value }))} placeholder="e.g. Queen St" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">To street</label>
              <input type="text" value={draft.to_street ?? ""} onChange={(e) => setDraft((d) => ({ ...d, to_street: e.target.value }))} placeholder="e.g. Park St" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Time limit (minutes)</label>
              <input type="number" min={0} value={draft.time_limit_minutes ?? ""} onChange={(e) => setDraft((d) => ({ ...d, time_limit_minutes: e.target.value === "" ? undefined : parseInt(e.target.value) }))} placeholder="e.g. 120" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Cost per hour ($)</label>
              <input type="number" min={0} step={0.25} value={draft.cost_per_hour ?? ""} onChange={(e) => setDraft((d) => ({ ...d, cost_per_hour: e.target.value === "" ? undefined : parseFloat(e.target.value) }))} placeholder="e.g. 2.50" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Notes</label>
            <textarea rows={2} value={draft.notes ?? ""} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} placeholder="Any additional info about this spot…" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none" />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button disabled={saving} onClick={save} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button disabled={saving} onClick={() => { setEditing(false); setDraft({}); setError(null); }} className="rounded-xl border border-gray-200 px-5 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Spots tab ────────────────────────────────────────────────────────────────

function SpotsTab() {
  const [spots, setSpots]           = useState<ParkingSpot[]>([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [error, setError]           = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/spots");
      if (!res.ok) throw new Error(await res.text());
      setSpots(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load spots");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = spots.filter((s) => {
    const matchType   = typeFilter === "all" || s.parking_type === typeFilter;
    const q           = search.toLowerCase();
    const matchSearch = !q || s.street_name?.toLowerCase().includes(q) || s.parking_type.includes(q) || s.notes?.toLowerCase().includes(q) || s.id.includes(q);
    return matchType && matchSearch;
  });

  const typeCounts = PARKING_TYPES.reduce<Record<string, number>>((acc, t) => {
    acc[t] = spots.filter((s) => s.parking_type === t).length;
    return acc;
  }, {});

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by street, type, notes…"
          className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-indigo-400 focus:outline-none"
        />
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTypeFilter("all")} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${typeFilter === "all" ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
            All ({spots.length})
          </button>
          {PARKING_TYPES.map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${typeFilter === t ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
              {t} ({typeCounts[t] ?? 0})
            </button>
          ))}
        </div>
        <button onClick={load} className="rounded-full border border-gray-200 px-4 py-1.5 text-sm text-gray-500 hover:bg-gray-50 flex-shrink-0">Refresh</button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="py-20 text-center text-gray-400">Loading spots…</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center text-gray-400">{spots.length === 0 ? "No spots in the database yet." : "No spots match your search."}</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((spot) => (
            <SpotRow
              key={spot.id}
              spot={spot}
              onSaved={load}
              onDeleted={() => setSpots((prev) => prev.filter((s) => s.id !== spot.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Root dashboard ───────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [tab, setTab] = useState<"submissions" | "spots">("submissions");

  return (
    <div>
      <div className="mb-6 flex gap-1 border-b border-gray-200">
        {(["submissions", "spots"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "submissions" ? "📷 Submissions" : "📍 Live Spots"}
          </button>
        ))}
      </div>
      {tab === "submissions" ? <SubmissionsTab /> : <SpotsTab />}
    </div>
  );
}
