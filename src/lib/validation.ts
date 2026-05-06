// ─── Halifax bounding box (generous — covers HRM municipality) ────────────────
// Tight downtown: lat 44.63–44.68, lng -63.62–-63.55
// Full HRM:       lat 44.30–45.20, lng -64.50–-62.80

const HRM_BOUNDS = {
  latMin: 44.30,
  latMax: 45.20,
  lngMin: -64.50,
  lngMax: -62.80,
} as const;

export function isHalifaxLocation(lat: number, lng: number): boolean {
  return (
    lat >= HRM_BOUNDS.latMin &&
    lat <= HRM_BOUNDS.latMax &&
    lng >= HRM_BOUNDS.lngMin &&
    lng <= HRM_BOUNDS.lngMax
  );
}

// ─── Proximity dedup — matches import script logic ────────────────────────────
// Returns distance in metres between two lat/lng points (Haversine)

export function distanceMetres(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Threshold: two spots closer than this (same type) → likely duplicate
export const PROXIMITY_DUPLICATE_METRES = 15;
