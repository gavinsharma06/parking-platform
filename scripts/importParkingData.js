// Run with: node --env-file=.env scripts/importParkingData.js

import { createClient } from "@supabase/supabase-js";

// ── URLs ──────────────────────────────────────────────────────────────────────

const ACCESSIBLE_PARKING_URL =
  "https://services2.arcgis.com/11XBiaBYA9Ep0yNJ/arcgis/rest/services/Accessible_Parking_Spots/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson";

const PAY_STATIONS_URL =
  "https://services2.arcgis.com/11XBiaBYA9Ep0yNJ/arcgis/rest/services/Parking_Pay_Stations/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson";

// ── Supabase client (uses service role to bypass RLS) ─────────────────────────
// Note: SUPABASE_SECRET_KEY must NOT have NEXT_PUBLIC_ prefix — keep it server-only

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_SECRET_KEY,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDurationMinutes(duration) {
  if (!duration) return null;
  const match = duration.match(/^HR(\d+)$/i);
  if (match) return parseInt(match[1], 10) * 60;
  return null;
}

// ── Transform functions ───────────────────────────────────────────────────────

function transformAccessible(feature) {
  const p = feature.properties;
  const [longitude, latitude] = feature.geometry.coordinates;
  return {
    latitude,
    longitude,
    street_name:        p.STREET_NAME ?? null,
    from_street:        p.FROM_STR    ?? null,
    to_street:          p.TO_STR      ?? null,
    parking_type:       "accessible",
    time_limit_minutes: parseDurationMinutes(p.DURATION),
    cost_per_hour:      0,
    source_type:        "hrm_arcgis",
    confidence_score:   1.0,
    notes:              p.COMMENTS ?? null,
    schedule:           null,
    is_active:          p.STATUS === "INS",
    external_id:        p.ACCPRKID ?? String(p.OBJECTID),
    raw_data:           p,
  };
}

function transformPaid(feature) {
  const p = feature.properties;
  const [longitude, latitude] = feature.geometry.coordinates;
  return {
    latitude,
    longitude,
    street_name:        p.LOCATION ?? null,
    from_street:        null,
    to_street:          null,
    parking_type:       "paid",
    time_limit_minutes: null,
    cost_per_hour:      null,
    source_type:        "hrm_arcgis",
    confidence_score:   1.0,
    notes:              null,
    schedule:           null,
    is_active:          p.ASSETSTAT === "INS",
    external_id:        p.PRKPAYID ?? String(p.OBJECTID),
    raw_data:           p,
  };
}

// ── Duplicate detection ───────────────────────────────────────────────────────
// For HRM data: the composite unique index on (source_type, external_id) handles
// same-source duplicates via upsert. This function catches cross-source duplicates:
// a spot is considered a duplicate if all three match an existing row —
//   1. within PROXIMITY_M metres
//   2. same parking_type
//   3. same street_name (case-insensitive, null-safe)
//
// Returns the array with likely cross-source duplicates filtered out.

const PROXIMITY_M = 15;

async function filterDuplicates(rows) {
  if (rows.length === 0) return rows;

  // Fetch all existing spots from other sources for comparison.
  // We only need: location, parking_type, street_name.
  const { data: existing, error } = await supabase
    .from("parking_spots")
    .select("latitude, longitude, parking_type, street_name")
    .neq("source_type", "hrm_arcgis"); // only cross-source check matters here

  if (error) {
    console.warn("Could not fetch existing spots for duplicate check:", error.message);
    return rows; // skip filter rather than block the import
  }
  if (!existing || existing.length === 0) return rows;

  const unique = [];
  let skipped = 0;

  for (const row of rows) {
    const isDuplicate = existing.some((ex) => {
      // 1. Same parking type
      if (ex.parking_type !== row.parking_type) return false;

      // 2. Same street name (null-safe, case-insensitive)
      const exStreet  = (ex.street_name  ?? "").toLowerCase().trim();
      const rowStreet = (row.street_name ?? "").toLowerCase().trim();
      if (exStreet && rowStreet && exStreet !== rowStreet) return false;

      // 3. Within PROXIMITY_M metres (Haversine approximation — good enough at city scale)
      const dLat = (ex.latitude  - row.latitude)  * (Math.PI / 180);
      const dLng = (ex.longitude - row.longitude) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(row.latitude * (Math.PI / 180)) *
        Math.cos(ex.latitude  * (Math.PI / 180)) *
        Math.sin(dLng / 2) ** 2;
      const distanceM = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 6_371_000;

      return distanceM <= PROXIMITY_M;
    });

    if (isDuplicate) {
      skipped++;
    } else {
      unique.push(row);
    }
  }

  if (skipped > 0) console.log(`Skipped (cross-source duplicates): ${skipped}`);
  return unique;
}

// ── Core function ─────────────────────────────────────────────────────────────

async function fetchAndImport(url, transformFn, label) {
  console.log(`\n── ${label} ─────────────────────────`);
  console.log(`Fetching: ${url}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);

  const data     = await response.json();
  const features = data.features;
  console.log(`Fetched:                     ${features.length} features`);

  const allRows = features.map(transformFn);
  console.log(`Transformed:                 ${allRows.length} rows`);

  // Filter cross-source duplicates before upserting
  const rows = await filterDuplicates(allRows);
  console.log(`After duplicate filter:      ${rows.length} rows`);

  if (rows.length === 0) { console.log("Nothing to upsert."); return; }

  // Upsert in batches of 500 to stay within Supabase request limits
  const BATCH = 500;
  let totalUpserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { count, error } = await supabase
      .from("parking_spots")
      // onConflict targets the composite unique index (source_type, external_id)
      .upsert(batch, { onConflict: "source_type,external_id", count: "exact" });

    if (error) { console.error("Supabase error:", error.message); process.exit(1); }
    totalUpserted += count ?? 0;
  }

  console.log(`Inserted/updated:            ${totalUpserted}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await fetchAndImport(ACCESSIBLE_PARKING_URL, transformAccessible, "Accessible parking");
  await fetchAndImport(PAY_STATIONS_URL,        transformPaid,        "Pay stations");
  console.log("\nDone.");
}

main().catch((err) => { console.error("Fatal:", err.message); process.exit(1); });
