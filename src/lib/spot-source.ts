// ─── Where the map's spots came from ──────────────────────────────────────────
// The map falls back to built-in sample spots when there is nothing to show.
// This records why, so the UI can say so instead of passing samples off as
// community data, and so a database outage is visible.

export type SpotDataSource =
  | "live"   // query succeeded with at least one row
  | "demo"   // query succeeded but the table is empty
  | "error"; // query failed

export function resolveSpotSource<T>(
  rows: T[] | null | undefined,
  error: unknown,
): { source: SpotDataSource; rows: T[] } {
  if (error) return { source: "error", rows: [] };
  if (!rows || rows.length === 0) return { source: "demo", rows: [] };
  return { source: "live", rows };
}

/** Text shown on the map when it is not displaying live data. */
export const SPOT_SOURCE_NOTICE: Record<Exclude<SpotDataSource, "live">, string> = {
  demo:  "Demo data, no community spots yet",
  error: "Live data unavailable, showing demo spots",
};
