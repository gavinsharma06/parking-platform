@AGENTS.md

# Park Off — Project Context for Claude

## What this is

Community-powered parking discovery app for Halifax, Nova Scotia.
Built by Gavin Sharma and Ishant Jethi.
Never add "Co-authored-by: Claude" to any commit.

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind v4
- Mapbox GL JS v3 — map rendering
- Supabase — Postgres + PostGIS + Storage
- Google Vision API — OCR for parking sign photos
- HRM ArcGIS Open Data — seed data source (accessible + paid spots)

## Current state

### Done

- Homepage: hero, Mapbox map, how-it-works, contribution CTA
- Map: color-coded pin markers, popups with street/time/cost, Google Maps link, legend, geolocation
- `/submit` page: full flow — camera → capture → GPS → OCR → Supabase upload (`SignCapture.tsx`)
- `/api/analyse-sign`: calls Google Vision, parses Halifax sign patterns (type/time/cost/schedule)
- `src/lib/submissions.ts`: uploads to `parking-signs` Storage bucket + inserts `sign_submissions` row
- DB schema: `supabase/migrations/20260423000000_initial_schema.sql` — `parking_spots`, `sign_submissions`, PostGIS, triggers, indexes
- `scripts/importParkingData.js`: fetches HRM ArcGIS open data (accessible + paid spots), deduplicates by (source_type, external_id) composite unique index + proximity check, upserts into Supabase. **Already run — accessible and paid spots are live in DB.**

### Not done

- Google Vision API key not set in prod `.env` → OCR returns 503
- Admin review UI — `sign_submissions` rows have no approve/reject interface
- User accounts / auth — none
- Free street parking data — no open data source exists; must be crowd-sourced
- Community verification flow (post-MVP)
- Vercel deployment not confirmed live

## The plan (phased)

### Phase 1 — Self-training (current focus)

Goal: populate free street parking spots with high-confidence data before opening to public.

How:

1. Gavin + Ishant walk Halifax streets with phones
2. Open `/submit`, grant camera + location
3. Photograph parking signs → Google Vision extracts type/time/cost/schedule
4. Review extracted data before submitting (already supported in UI — "Analyse Sign" → "Confirm & Submit")
5. Submissions land in `sign_submissions` (Supabase) with `status = 'pending_review'`
6. Admin approves → row promoted to `parking_spots`

**Blocker: no admin review UI exists yet. This is next priority.**

### Phase 2 — Soft launch (community testing, ~2 weeks)

- Open `/submit` to public
- Monitor all incoming submissions closely
- Every submission reviewed manually before going live
- Validate: Is it Halifax? Is GPS plausible? Does extracted data match photo?
- Gate: if Google Vision accuracy is acceptable over 2 weeks → move to Phase 3

### Phase 3 — Auto-pipeline

- Google Vision extracts data → auto-validation checks run:
  1. GPS coordinates inside Halifax bounding box
  2. Duplicate check: proximity + type match against existing `parking_spots`
  3. Confidence threshold on extracted fields
- If all pass → auto-approve into `parking_spots`, no human needed
- If any fail → queue for manual review
- User data is never manually touched — fully pipeline-managed

## Next steps (in order)

1. **Admin review UI** — simple `/admin` page: list `sign_submissions`, show photo + extracted data + GPS, approve/reject buttons → on approve, upserts into `parking_spots`
2. **Wire env vars** — set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `GOOGLE_VISION_API_KEY` in Vercel / local `.env`
3. **Deploy to Vercel** — confirm live URL
4. **Start Phase 1 self-training** — Gavin + Ishant submit real signs
5. **Auto-validation logic** — Halifax bounding box check, duplicate proximity check (reuse logic from import script)

## Key files

- `src/components/map/ParkingMap.tsx` — full map component (markers, popups, Supabase fetch, sample fallback)
- `src/components/capture/SignCapture.tsx` — camera/OCR/submit flow
- `src/app/api/analyse-sign/route.ts` — Google Vision route + Halifax sign parser
- `src/lib/submissions.ts` — Supabase upload helper
- `scripts/importParkingData.js` — HRM open data importer (run once, already done)
- `supabase/migrations/20260423000000_initial_schema.sql` — full DB schema

## DB tables (key ones)

- `parking_spots` — live spots on map. `source_type` ∈ {manual, user, osm, inferred, hrm_arcgis}
- `sign_submissions` — raw user submissions awaiting review. Has `status` (pending_review / approved / rejected), `image_path`, `latitude`, `longitude`, `extracted_data` (JSONB)

## Constraints

- No duplicate entries: enforced by composite unique index `(source_type, external_id)` + proximity dedup in import script
- User data never manually touched once auto-pipeline is active (Phase 3)
- All GPS positions must be Halifax-area (validate before insert)
