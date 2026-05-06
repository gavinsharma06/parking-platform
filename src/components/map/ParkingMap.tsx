"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import type { GeoJSONSource } from "mapbox-gl";
import type { FeatureCollection, Point } from "geojson";
import "mapbox-gl/dist/mapbox-gl.css";
import { supabase } from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const HALIFAX_CENTER: [number, number] = [-63.5788, 44.6476];
const ZOOM = 14;
const HRM_BBOX = "-64.5,44.3,-62.8,45.2";

const TYPE_COLOR: Record<string, string> = {
  free:       "#16a34a",
  paid:       "#2563eb",
  permit:     "#d97706",
  accessible: "#0ea5e9",
  unknown:    "#6b7280",
};

const TYPE_LABEL: Record<string, string> = {
  free:       "Free parking",
  paid:       "Paid parking",
  permit:     "Permit only",
  accessible: "Accessible",
  unknown:    "Unknown",
};

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
};

type SearchResult = {
  id: string;
  place_name: string;
  center: [number, number];
};

// ─── Sample fallback ──────────────────────────────────────────────────────────

const SAMPLE_SPOTS: Spot[] = [
  { id: "s1", latitude: 44.6488, longitude: -63.5752, parking_type: "free",       street_name: "Spring Garden Rd", from_street: "Queen St",     to_street: "Park St",   time_limit_minutes: 120,  cost_per_hour: null, notes: null },
  { id: "s2", latitude: 44.6468, longitude: -63.5729, parking_type: "paid",       street_name: "Barrington St",    from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: 2.50, notes: null },
  { id: "s3", latitude: 44.6502, longitude: -63.5771, parking_type: "permit",     street_name: "Robie St",         from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: null, notes: "Zone A permit required" },
  { id: "s4", latitude: 44.6479, longitude: -63.5810, parking_type: "free",       street_name: "Queen St",         from_street: "Brunswick St", to_street: "Hollis St", time_limit_minutes: 60,   cost_per_hour: null, notes: null },
  { id: "s5", latitude: 44.6455, longitude: -63.5760, parking_type: "paid",       street_name: "Granville St",     from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: 3.00, notes: null },
  { id: "s6", latitude: 44.6510, longitude: -63.5740, parking_type: "accessible", street_name: "Brunswick St",     from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: null, notes: null },
  { id: "s7", latitude: 44.6440, longitude: -63.5790, parking_type: "unknown",    street_name: "Lower Water St",   from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: null, notes: null },
  { id: "s8", latitude: 44.6495, longitude: -63.5800, parking_type: "paid",       street_name: "Hollis St",        from_street: null,           to_street: null,        time_limit_minutes: null, cost_per_hour: 2.00, notes: null },
  { id: "s9", latitude: 44.6520, longitude: -63.5760, parking_type: "free",       street_name: "University Ave",   from_street: null,           to_street: null,        time_limit_minutes: 90,   cost_per_hour: null, notes: null },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function spotsToGeoJSON(spots: Spot[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: spots.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
      properties: { ...s },
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
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<mapboxgl.Map | null>(null);
  const mapReady     = useRef(false);
  const spotsRef     = useRef<Spot[]>([]);
  const searchTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef    = useRef<HTMLDivElement>(null);

  const [spots,       setSpots]       = useState<Spot[]>([]);
  const [selected,    setSelected]    = useState<Spot | null>(null);
  const [query,       setQuery]       = useState("");
  const [results,     setResults]     = useState<SearchResult[]>([]);
  const [searching,   setSearching]   = useState(false);
  const [showResults, setShowResults] = useState(false);

  // ── Fetch spots ──────────────────────────────────────────────────────────

  useEffect(() => {
    supabase
      .from("parking_spots")
      .select("id,latitude,longitude,parking_type,street_name,from_street,to_street,time_limit_minutes,cost_per_hour,notes")
      .eq("is_active", true)
      .then(({ data }) => setSpots(data && data.length > 0 ? (data as Spot[]) : SAMPLE_SPOTS));
  }, []);

  // ── Add / update GeoJSON source & layers ──────────────────────────────────

  function addLayers(map: mapboxgl.Map, data: FeatureCollection<Point>) {
    map.addSource("spots", {
      type: "geojson",
      data,
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 40,
    });

    // Cluster circles
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

    // Cluster count labels
    map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "spots",
      filter: ["has", "point_count"],
      layout: { "text-field": "{point_count_abbreviated}", "text-size": 12, "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"] },
      paint: { "text-color": "#fff" },
    });

    // Individual spots — GPU-rendered, data-driven color, size scales with zoom
    map.addLayer({
      id: "spots",
      type: "circle",
      source: "spots",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 7, 17, 10],
        "circle-color": [
          "match", ["get", "parking_type"],
          "free",       TYPE_COLOR.free,
          "paid",       TYPE_COLOR.paid,
          "permit",     TYPE_COLOR.permit,
          "accessible", TYPE_COLOR.accessible,
          TYPE_COLOR.unknown,
        ],
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

    // Click individual spot
    map.on("click", "spots", (e) => {
      if (!e.features?.length) return;
      const props = e.features[0].properties as Record<string, unknown>;
      const spot: Spot = {
        id:                 String(props.id ?? ""),
        latitude:           Number(props.latitude),
        longitude:          Number(props.longitude),
        parking_type:       String(props.parking_type ?? "unknown"),
        street_name:        props.street_name ? String(props.street_name) : null,
        from_street:        props.from_street  ? String(props.from_street)  : null,
        to_street:          props.to_street    ? String(props.to_street)    : null,
        time_limit_minutes: props.time_limit_minutes != null ? Number(props.time_limit_minutes) : null,
        cost_per_hour:      props.cost_per_hour != null      ? Number(props.cost_per_hour)      : null,
        notes:              props.notes ? String(props.notes) : null,
      };
      setSelected(spot);
      map.easeTo({ center: e.lngLat, offset: [0, -100], duration: 250 });
      e.originalEvent.stopPropagation();
    });

    // Click cluster → zoom in
    map.on("click", "clusters", (e) => {
      if (!e.features?.length) return;
      const clusterId = e.features[0].properties?.cluster_id as number;
      const src = map.getSource("spots") as GeoJSONSource;
      src.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || zoom == null) return;
        map.easeTo({ center: (e.features![0].geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      });
    });

    // Pointer cursors
    map.on("mouseenter", "spots",    () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "spots",    () => { map.getCanvas().style.cursor = ""; });
    map.on("mouseenter", "clusters", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; });

    // Click empty map → close sheet
    map.on("click", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["spots", "clusters"] });
      if (!features.length) setSelected(null);
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

    if (!mapReady.current) return; // map.on("load") will call addLayers instead

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
    mapRef.current?.flyTo({ center: r.center, zoom: 15.5, duration: 900 });
  }, []);

  useEffect(() => {
    const hide = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowResults(false);
    };
    document.addEventListener("mousedown", hide);
    return () => document.removeEventListener("mousedown", hide);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────

  const spotColor = selected ? (TYPE_COLOR[selected.parking_type] ?? TYPE_COLOR.unknown) : "";
  const spotLabel = selected ? (TYPE_LABEL[selected.parking_type] ?? "Parking") : "";
  const chips: string[] = [];
  if (selected?.time_limit_minutes) chips.push(`⏱ ${formatTimeLimit(selected.time_limit_minutes)}`);
  if (selected && selected.cost_per_hour != null && selected.cost_per_hour > 0) chips.push(`💰 $${selected.cost_per_hour.toFixed(2)}/hr`);
  else if (selected?.parking_type === "paid") chips.push("💰 See meter");
  const mapsUrl = selected
    ? `https://www.google.com/maps/dir/?api=1&destination=${selected.latitude},${selected.longitude}`
    : "";

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
          {searching && (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">…</span>
          )}
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
          {Object.entries(TYPE_LABEL).map(([type, lbl]) => (
            <div key={type} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: TYPE_COLOR[type] }} />
              <span className="text-xs text-gray-600">{lbl}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Bottom sheet ────────────────────────────────────────────────── */}
      {selected && (
        <div className="absolute bottom-0 left-0 right-0 z-20 rounded-t-2xl bg-white shadow-2xl" style={{ animation: "slideUp 0.2s ease-out" }}>
          <div className="flex justify-center pt-2.5">
            <div className="h-1 w-8 rounded-full bg-gray-200" />
          </div>
          <div className="px-5 pt-3 pb-8">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold text-white" style={{ background: spotColor }}>
                <span className="h-2 w-2 rounded-full bg-white/50" />
                {spotLabel}
              </span>
              <button
                onClick={() => setSelected(null)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm text-gray-500 hover:bg-gray-200"
              >
                ✕
              </button>
            </div>

            {selected.street_name && (
              <p className="mt-3 text-base font-bold text-gray-900">{selected.street_name}</p>
            )}
            {selected.from_street && selected.to_street && (
              <p className="mt-0.5 text-sm text-gray-500">{selected.from_street} → {selected.to_street}</p>
            )}

            {chips.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {chips.map((c) => (
                  <span key={c} className="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700">{c}</span>
                ))}
              </div>
            )}

            {selected.notes && (
              <p className="mt-2 text-sm italic text-gray-500">{selected.notes}</p>
            )}

            <a
              href={mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3.5 text-sm font-semibold text-white active:bg-indigo-700"
            >
              Get directions ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
