"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import type { GeoJSONSource } from "mapbox-gl";
import type { FeatureCollection, Point } from "geojson";
import "mapbox-gl/dist/mapbox-gl.css";
import { supabase } from "@/lib/supabase";
import {
  evaluateSpot,
  ruleLabel,
  formatDays,
  formatTimeWindow,
  STATUS_COLOR,
  RULE_TYPE_COLOR,
  RULE_TYPE_LABEL,
  HALIFAX_DEFAULT_PAID_RULES,
} from "@/lib/parking-rules";
import type { SpotSchedule, ParkingRule } from "@/lib/parking-rules";

// ─── Constants ────────────────────────────────────────────────────────────────

const HALIFAX_CENTER: [number, number] = [-63.5788, 44.6476];
const ZOOM = 14;
const HRM_BBOX = "-64.5,44.3,-62.8,45.2";

// ─── Types ────────────────────────────────────────────────────────────────────

type Spot = {
  id: string;
  latitude: number;
  longitude: number;
  parking_type: string;
  street_name: string | null;
  from_street: string | null;
  to_street: string | null;
  time_limit_minutes: number | null;
  cost_per_hour: number | null;
  notes: string | null;
  schedule: SpotSchedule | null;
  // computed at render time
  current_status: string;
  current_color: string;
  current_label: string;
};

type SearchResult = {
  id: string;
  place_name: string;
  center: [number, number];
};

// ─── Sample fallback ──────────────────────────────────────────────────────────

const SAMPLE_SPOTS: Omit<Spot, "current_status" | "current_color" | "current_label">[] = [
  { id: "s1", latitude: 44.6488, longitude: -63.5752, parking_type: "free",       street_name: "Spring Garden Rd", from_street: "Queen St",     to_street: "Park St",   time_limit_minutes: 120,  cost_per_hour: null, notes: null, schedule: null },
  { id: "s2", latitude: 44.6468, longitude: -63.5729, parking_type: "paid",       street_name: "Barrington St",    from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: 2.50, notes: null, schedule: { rules: HALIFAX_DEFAULT_PAID_RULES } },
  { id: "s3", latitude: 44.6502, longitude: -63.5771, parking_type: "permit",     street_name: "Robie St",         from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: null, notes: "Zone A permit required", schedule: null },
  { id: "s4", latitude: 44.6479, longitude: -63.5810, parking_type: "free",       street_name: "Queen St",         from_street: "Brunswick St", to_street: "Hollis St", time_limit_minutes: 60,   cost_per_hour: null, notes: null, schedule: null },
  { id: "s5", latitude: 44.6455, longitude: -63.5760, parking_type: "paid",       street_name: "Granville St",     from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: 3.00, notes: null, schedule: { rules: HALIFAX_DEFAULT_PAID_RULES } },
  { id: "s6", latitude: 44.6510, longitude: -63.5740, parking_type: "accessible", street_name: "Brunswick St",     from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: null, notes: null, schedule: null },
  { id: "s7", latitude: 44.6440, longitude: -63.5790, parking_type: "unknown",    street_name: "Lower Water St",   from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: null, notes: null, schedule: null },
  { id: "s8", latitude: 44.6495, longitude: -63.5800, parking_type: "paid",       street_name: "Hollis St",        from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: 2.00, notes: null, schedule: { rules: HALIFAX_DEFAULT_PAID_RULES } },
  { id: "s9", latitude: 44.6520, longitude: -63.5760, parking_type: "free",       street_name: "University Ave",   from_street: null,           to_street: null,        time_limit_minutes: 90,   cost_per_hour: null, notes: null, schedule: null },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeSpots(raw: typeof SAMPLE_SPOTS, now: Date): Spot[] {
  return raw.map((s) => {
    const explicitRules = s.schedule?.rules ?? [];
    // On-street paid spots with no explicit schedule get the HRM default:
    // paid Mon–Fri 8AM–6PM, free all other times.
    const rules = explicitRules.length > 0
      ? explicitRules
      : s.parking_type === "paid" ? HALIFAX_DEFAULT_PAID_RULES : [];

    if (rules.length > 0) {
      const ev = evaluateSpot(rules, now);
      return { ...s, current_status: ev.status, current_color: ev.color, current_label: ev.label };
    }
    // No rules at all — fall back to static parking_type
    const color = STATUS_COLOR[s.parking_type] ?? STATUS_COLOR.unknown;
    const label = s.parking_type.charAt(0).toUpperCase() + s.parking_type.slice(1) + " parking";
    return { ...s, current_status: s.parking_type, current_color: color, current_label: label };
  });
}

function spotsToGeoJSON(spots: Spot[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: spots.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
      properties: { ...s, schedule: JSON.stringify(s.schedule) },
    })),
  };
}

function formatTimeLimit(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""} limit` : `${m}m limit`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ParkingMap() {
  const containerRef    = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<mapboxgl.Map | null>(null);
  const mapReady        = useRef(false);
  const spotsRef        = useRef<Spot[]>([]);
  const searchTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef       = useRef<HTMLDivElement>(null);
  const searchMarkerRef = useRef<mapboxgl.Marker | null>(null);

  const [spots,            setSpots]            = useState<Spot[]>([]);
  const [selected,         setSelected]         = useState<Spot | null>(null);
  const [resolvedStreet,   setResolvedStreet]   = useState<string | null>(null);
  const [query,            setQuery]            = useState("");
  const [results,          setResults]          = useState<SearchResult[]>([]);
  const [searching,        setSearching]        = useState(false);
  const [showResults,      setShowResults]      = useState(false);

  // ── Fetch spots ──────────────────────────────────────────────────────────

  useEffect(() => {
    supabase
      .from("parking_spots")
      .select("id,latitude,longitude,parking_type,street_name,from_street,to_street,time_limit_minutes,cost_per_hour,notes,schedule")
      .eq("is_active", true)
      .then(({ data }) => {
        const raw = (data && data.length > 0 ? data : SAMPLE_SPOTS) as typeof SAMPLE_SPOTS;
        setSpots(computeSpots(raw, new Date()));
      });
  }, []);

  // Refresh status every 5 minutes so colors update without a page reload
  useEffect(() => {
    const interval = setInterval(() => {
      setSpots((prev) => computeSpots(prev, new Date()));
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // ── Reverse-geocode street name for spots that don't have one stored ─────

  useEffect(() => {
    setResolvedStreet(null);
    if (!selected || selected.street_name) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
    fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${selected.longitude},${selected.latitude}.json` +
      `?access_token=${token}&types=address&limit=1`,
    )
      .then((r) => r.json())
      .then((data) => {
        const name: string | undefined = data.features?.[0]?.place_name;
        if (name) setResolvedStreet(name.split(",")[0]);
      })
      .catch(() => {});
  }, [selected]);

  // ── Add / update GeoJSON source & layers ──────────────────────────────────

  function addLayers(map: mapboxgl.Map, data: FeatureCollection<Point>) {
    map.addSource("spots", {
      type: "geojson",
      data,
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 40,
    });

    map.addLayer({
      id: "clusters",
      type: "circle",
      source: "spots",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#4f46e5",
        "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 28],
        "circle-opacity": 0.85,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });

    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "spots",
      filter: ["has", "point_count"],
      layout: {
        "text-field": "{point_count_abbreviated}",
        "text-size": 12,
        "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
      },
      paint: { "text-color": "#fff" },
    });

    // Color driven by computed current_color stored in GeoJSON properties
    map.addLayer({
      id: "spots",
      type: "circle",
      source: "spots",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 7, 17, 10],
        "circle-color": ["get", "current_color"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#fff",
        "circle-opacity": 0.95,
      },
    });
  }

  // ── Init map ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: HALIFAX_CENTER,
      zoom: ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
      }),
      "top-right",
    );

    map.on("load", () => {
      mapReady.current = true;
      if (spotsRef.current.length > 0) {
        addLayers(map, spotsToGeoJSON(spotsRef.current));
      }
    });

    map.on("click", "spots", (e) => {
      if (!e.features?.length) return;
      const props = e.features[0].properties as Record<string, unknown>;
      let schedule: SpotSchedule | null = null;
      try { schedule = JSON.parse(props.schedule as string); } catch { /* ignore */ }
      const spot: Spot = {
        id:                  String(props.id ?? ""),
        latitude:            Number(props.latitude),
        longitude:           Number(props.longitude),
        parking_type:        String(props.parking_type ?? "unknown"),
        street_name:         props.street_name  ? String(props.street_name)  : null,
        from_street:         props.from_street  ? String(props.from_street)  : null,
        to_street:           props.to_street    ? String(props.to_street)    : null,
        time_limit_minutes:  props.time_limit_minutes != null ? Number(props.time_limit_minutes) : null,
        cost_per_hour:       props.cost_per_hour      != null ? Number(props.cost_per_hour)      : null,
        notes:               props.notes ? String(props.notes) : null,
        schedule,
        current_status:      String(props.current_status ?? "unknown"),
        current_color:       String(props.current_color  ?? STATUS_COLOR.unknown),
        current_label:       String(props.current_label  ?? "Parking"),
      };
      setSelected(spot);
      map.easeTo({ center: e.lngLat, offset: [0, -120], duration: 250 });
      e.originalEvent.stopPropagation();
    });

    map.on("click", "clusters", (e) => {
      if (!e.features?.length) return;
      const clusterId = e.features[0].properties?.cluster_id as number;
      const src = map.getSource("spots") as GeoJSONSource;
      src.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || zoom == null) return;
        map.easeTo({
          center: (e.features![0].geometry as GeoJSON.Point).coordinates as [number, number],
          zoom,
        });
      });
    });

    map.on("mouseenter", "spots",    () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "spots",    () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "clusters", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; });
    map.on("click", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["spots", "clusters"] });
      if (!features.length) {
        setSelected(null);
        searchMarkerRef.current?.remove();
        searchMarkerRef.current = null;
      }
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; mapReady.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync spots → map source ───────────────────────────────────────────────

  useEffect(() => {
    spotsRef.current = spots;
    const map = mapRef.current;
    if (!map || spots.length === 0) return;
    if (!mapReady.current) return;

    const src = map.getSource("spots") as GeoJSONSource | undefined;
    if (src) {
      src.setData(spotsToGeoJSON(spots));
    } else {
      addLayers(map, spotsToGeoJSON(spots));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spots]);

  // ── Geocoding search ─────────────────────────────────────────────────────

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    setShowResults(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!value.trim()) { setResults([]); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(value)}.json` +
          `?access_token=${token}&bbox=${HRM_BBOX}&proximity=-63.5788,44.6476&types=address,place,neighborhood,locality&limit=5`,
        );
        const data = await res.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setResults((data.features ?? []).map((f: any) => ({ id: f.id, place_name: f.place_name, center: f.center })));
      } catch { setResults([]); }
      finally  { setSearching(false); }
    }, 320);
  }, []);

  const selectResult = useCallback((r: SearchResult) => {
    setQuery(r.place_name.split(",")[0]);
    setResults([]);
    setShowResults(false);
    const map = mapRef.current;
    if (!map) return;
    searchMarkerRef.current?.remove();
    map.flyTo({ center: r.center, zoom: 15.5, duration: 900 });
    searchMarkerRef.current = new mapboxgl.Marker({ color: "#4f46e5" })
      .setLngLat(r.center)
      .addTo(map);
  }, []);

  useEffect(() => {
    const hide = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener("mousedown", hide);
    return () => document.removeEventListener("mousedown", hide);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────

  const explicitRules: ParkingRule[] = selected?.schedule?.rules ?? [];
  const usingHrmDefault = explicitRules.length === 0 && selected?.parking_type === "paid";
  const rules: ParkingRule[] = explicitRules.length > 0
    ? explicitRules
    : usingHrmDefault ? HALIFAX_DEFAULT_PAID_RULES : [];
  const now = new Date();
  const mapsUrl = selected
    ? `https://www.google.com/maps/dir/?api=1&destination=${selected.latitude},${selected.longitude}`
    : "";

  // Legend entries: unique statuses in current data
  const legendEntries: { color: string; label: string }[] = [
    { color: STATUS_COLOR.free,        label: "Free parking" },
    { color: STATUS_COLOR.paid,        label: "Paid parking" },
    { color: STATUS_COLOR.permit,      label: "Permit only" },
    { color: STATUS_COLOR.accessible,  label: "Accessible" },
    { color: STATUS_COLOR.no_stopping, label: "No stopping / No parking" },
    { color: STATUS_COLOR.unknown,     label: "Unknown" },
  ];

  return (
    <div className="relative h-full w-full overflow-hidden">

      {/* ── Search bar ──────────────────────────────────────────────────── */}
      <div ref={searchRef} className="absolute top-3 left-3 right-14 z-10">
        <div className="relative">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          <input
            type="text"
            placeholder="Search Halifax location…"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            onFocus={() => query && setShowResults(true)}
            className="h-11 w-full rounded-xl border border-gray-200 bg-white pl-9 pr-4 text-sm shadow-lg placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {searching && <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">…</span>}
        </div>

        {showResults && results.length > 0 && (
          <ul className="mt-1 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-xl">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => selectResult(r)}
                  className="flex w-full items-start gap-2.5 px-4 py-3 text-left text-sm hover:bg-indigo-50 active:bg-indigo-100"
                >
                  <span className="mt-0.5 shrink-0 text-indigo-400">📍</span>
                  <span className="text-gray-800">{r.place_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Map canvas ──────────────────────────────────────────────────── */}
      <div ref={containerRef} className="h-full w-full" />

      {/* ── Legend ──────────────────────────────────────────────────────── */}
      {!selected && (
        <div className="absolute bottom-4 left-3 z-10 flex flex-col gap-1.5 rounded-xl border border-gray-100 bg-white/95 px-3 py-2.5 shadow-md backdrop-blur-sm">
          {legendEntries.map((e) => (
            <div key={e.label} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
              <span className="text-xs text-gray-600">{e.label}</span>
            </div>
          ))}
          <p className="mt-1 text-[10px] text-gray-400">Colors reflect current time</p>
        </div>
      )}

      {/* ── Bottom sheet ────────────────────────────────────────────────── */}
      {selected && (
        <div
          className="absolute bottom-0 left-0 right-0 z-20 max-h-[70vh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl"
          style={{ animation: "slideUp 0.2s ease-out" }}
        >
          <div className="flex justify-center pt-2.5">
            <div className="h-1 w-8 rounded-full bg-gray-200" />
          </div>

          <div className="px-5 pt-3 pb-8 space-y-4">

            {/* Status badge + close */}
            <div className="flex items-center justify-between">
              <span
                className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold text-white"
                style={{ background: selected.current_color }}
              >
                <span className="h-2 w-2 rounded-full bg-white/50" />
                {selected.current_label}
              </span>
              <button
                onClick={() => setSelected(null)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm text-gray-500 hover:bg-gray-200"
              >
                ✕
              </button>
            </div>

            {/* Street info */}
            {(() => {
              const name = selected.street_name ?? resolvedStreet;
              if (name) {
                return (
                  <div>
                    <p className="text-base font-bold text-gray-900">{name}</p>
                    {selected.from_street && selected.to_street && (
                      <p className="mt-0.5 text-sm text-gray-500">
                        {selected.from_street} → {selected.to_street}
                      </p>
                    )}
                  </div>
                );
              }
              if (!selected.street_name && !resolvedStreet) {
                return <p className="text-sm text-gray-400 animate-pulse">Looking up address…</p>;
              }
              return null;
            })()}

            {/* Legacy chips (shown when no structured rules) */}
            {rules.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {selected.time_limit_minutes != null && (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700">
                    ⏱ {formatTimeLimit(selected.time_limit_minutes)}
                  </span>
                )}
                {selected.cost_per_hour != null && selected.cost_per_hour > 0 && (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700">
                    💰 ${selected.cost_per_hour.toFixed(2)}/hr
                  </span>
                )}
                {selected.notes && (
                  <p className="text-sm italic text-gray-500">{selected.notes}</p>
                )}
              </div>
            )}

            {/* Structured rules list */}
            {rules.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  All rules for this location
                </p>
                <div className="space-y-2">
                  {rules.map((rule, i) => {
                    const active = (() => {
                      // Quick active check for highlighting
                      const day = now.getDay();
                      const mins = now.getHours() * 60 + now.getMinutes();
                      if (rule.days && !rule.days.includes(day)) return false;
                      if (rule.time_window) {
                        const s = rule.time_window.start.split(":").map(Number);
                        const e = rule.time_window.end.split(":").map(Number);
                        const sm = s[0] * 60 + s[1];
                        const em = e[0] * 60 + e[1];
                        if (sm <= em) return mins >= sm && mins < em;
                        return mins >= sm || mins < em;
                      }
                      return true;
                    })();

                    return (
                      <div
                        key={i}
                        className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${
                          active ? "bg-gray-50 ring-1 ring-inset ring-gray-200" : "opacity-50"
                        }`}
                      >
                        <span
                          className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: RULE_TYPE_COLOR[rule.rule_type] }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-gray-800">
                              {RULE_TYPE_LABEL[rule.rule_type]}
                            </span>
                            {rule.tow_away && rule.rule_type !== "no_stopping" && (
                              <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                                TOW AWAY
                              </span>
                            )}
                            {active && (
                              <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                ACTIVE NOW
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-gray-500">
                            {[
                              rule.time_window ? formatTimeWindow(rule.time_window) : "24/7",
                              formatDays(rule.days),
                              rule.time_limit_minutes != null
                                ? formatTimeLimit(rule.time_limit_minutes)
                                : null,
                              rule.cost_per_hour != null
                                ? `$${rule.cost_per_hour.toFixed(2)}/hr`
                                : null,
                              rule.permit_zone ? `Zone ${rule.permit_zone}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* HRM default note */}
            {usingHrmDefault && (
              <div className="rounded-xl border border-blue-100 bg-blue-50 px-3.5 py-3 text-xs text-blue-700 leading-relaxed">
                <span className="font-semibold">On-street parking (HRM default):</span> Free after 6PM on weekdays, all day on weekends, and most holidays. Check signage for special events or winter overnight bans.
              </div>
            )}

            {/* Directions */}
            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3.5 text-sm font-semibold text-white active:bg-indigo-700"
            >
              Get directions ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
