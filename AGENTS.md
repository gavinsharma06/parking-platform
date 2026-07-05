<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:project-context -->

# Park Off — Project context for AI assistants

## What this project is
Community-powered parking discovery app for Halifax, Nova Scotia. Users photograph parking signs; OCR extracts the rules; spots appear on a live map. Stack: Next.js 16 (App Router), React 19, Tailwind v4, TypeScript, Mapbox GL JS v3, Supabase, Google Cloud Vision API.

## Google Cloud setup
- **Project**: "My First Project" on GCP (project ID: `project-e70c5b2e-77aa-46cb-ac1`)
- **Service account**: `vision-service@project-e70c5b2e-77aa-46cb-ac1.iam.gserviceaccount.com` — has VisionAI Admin (Beta) role
- **API key**: named `park-off`, restricted to Cloud Vision API only
- **Auth method**: API key passed as `GOOGLE_VISION_API_KEY` env var (server-side only, never exposed to browser)
- **Org policy**: `iam.disableServiceAccountKeyCreation` is enforced at org level — service account JSON keys cannot be created. Use API keys or Workload Identity Federation instead.

## Vision API integration
- Entry point: `src/app/api/analyse-sign/route.ts`
- Calls `TEXT_DETECTION` feature (not `DOCUMENT_TEXT_DETECTION` — parking signs are short, sparse text)
- Returns `ExtractedParkingData` (defined in `src/lib/parking-rules.ts`):
  - `rules: ParkingRule[]` — structured array, one entry per sign on the pole (primary output)
  - `raw_text: string` — full OCR string for display/debugging
  - `confidence: number` — 0.1–1.0 heuristic based on how much structure was extracted
  - Legacy fields (`parking_type`, `time_limit_minutes`, `cost_per_hour`, `schedule`) — kept for backward compat
- Images are sent as base64 JPEG in the request body

### Parser pipeline (`src/app/api/analyse-sign/route.ts`)
The parser runs in four stages:

1. **`normalizeRaw(raw)`** — pre-joins keyword fragments Vision commonly splits across lines:
   `TOW\nAWAY` → `TOW AWAY`, `PAY\nZONE` → `PAY ZONE`, `STREET\nCLEANING` → `STREET CLEANING`, etc.

2. **`segmentText(raw)`** — splits OCR text into per-sign segments using `SIGN_ANCHORS` regex array.
   - Noise lines (lone `P`, `®`, symbols) are filtered before splitting.
   - Time/day-only header lines that appear before the first anchor (e.g. `7AM 9AM` above a visual no-stopping arrow) are buffered in `pending` and prepended to the next segment so their time window is found first.
   - Day-only lines (`MON-FRI`) are also buffered the same way.

3. **`parseSegment(text)`** — classifies each segment and extracts:
   - `rule_type` + `is_prohibited` + `tow_away` via `classifySegment()`
   - `days: number[] | null` — `parseDays()` normalises the `IMON-FRI` OCR artifact (leading `I` before day abbreviations) before matching
   - `time_window: {start, end} | null` — `parseTimeWindow()` tries dash-separated first, then space-separated fallback (`12AM 8AM`); picks whichever match starts earliest in the text so a pending time header wins over a later time range from a different sign
   - `time_limit_minutes: number | null` — `parseTimeLimit()` matches `3 HR`, `3HR`, `3 HOUR`, `30 MIN`, etc.
   - `cost_per_hour`, `permit_zone`

4. **`deduplicateRules(rules)`** — removes bare duplicate rules (same `rule_type`, no time/day/cost/permit info) when a richer rule of the same type already exists. Prevents `PAY ZONE` label text from generating a phantom paid-24/7 rule alongside a properly-timestamped `PAYMENT REQUIRED` rule.

### Batch OCR test script
```
node scripts/run-ocr-batch.js <folder>
node scripts/run-ocr-batch.js parkingsigns
```
Runs the full parser pipeline against every image in a folder and prints raw OCR + extracted rules. The inline parser in this script must be kept in sync with `route.ts`.

- Returns: `{ parking_type, time_limit_minutes, cost_per_hour, schedule, raw_text }`
- Parser handles Halifax-specific patterns: time limits, cost per hour, zone permits, accessible spots, schedule ranges
- Images are sent as base64 JPEG in the request body

## Google Cloud Vision — best practices (sourced from official docs: docs.cloud.google.com/vision)

### Image formats
Supported: JPEG, PNG8, PNG24, GIF (first frame only), BMP, WEBP, RAW, ICO, PDF, TIFF.
Park Off accepts JPEG only — correct choice. Lossy formats like JPEG should not be over-compressed as it degrades OCR accuracy.

### Image dimensions (official recommendations)
- `TEXT_DETECTION` and `DOCUMENT_TEXT_DETECTION`: **1024×768 minimum** (OCR needs more resolution than other features)
- Absolute minimum for any Vision API call: 640×480
- Do NOT send images larger than needed — bigger than 1024×768 increases latency with no accuracy gain for sign text
- Hard limit: image must not exceed **75,000,000 pixels** (length × width) — Vision API will resize if exceeded
- `SignCapture.tsx` should resize/compress to ~1024×768 before sending

### File size limits (official)
- Max image file size: **20 MB** — files over this return an error
- Max **JSON request body**: **10 MB** — base64-encoded images in the request body must stay under this
- Current approach in `route.ts` (base64 in JSON body) is fine for phone photos compressed to JPEG ~200-500KB
- If images ever exceed ~7MB base64, switch to GCS URI approach instead of base64 inline

### TEXT_DETECTION vs DOCUMENT_TEXT_DETECTION
- **`TEXT_DETECTION`** — use this for parking signs. Returns full extracted string + individual words + bounding boxes. Optimised for sparse text in photos.
- **`DOCUMENT_TEXT_DETECTION`** — for dense documents, PDFs, handwriting. Returns page/block/paragraph/word structure. Overkill for signs, slower.
- Current implementation correctly uses `TEXT_DETECTION`. Do not change this.
- `textAnnotations[0].description` = full concatenated text string — always use this for the parser, not individual word entries.

### Language hints
- **Leave `languageHints` empty** — auto-detection yields best results for Latin alphabet text (English/French Halifax signs)
- Only set language hints if OCR accuracy is poor on non-Latin scripts — not applicable here
- Setting a wrong hint is worse than setting none

### API design rules
- Vision API is **stateless** — every call is fully independent, no sessions or context
- Always send a **single feature type per request** — multiple features increase response size unnecessarily
- Do NOT call Vision API client-side — always route through `/api/analyse-sign` (already correct)
- For production scale: use **async batch annotation** (up to 2000 images, results to GCS) — not needed yet but relevant for bulk HRM data imports

### Cost control (project on free trial — $415.88 credit remaining)
- `TEXT_DETECTION`: **$1.50 per 1000 requests** after first 1000/month free
- Gate order in `SignCapture.tsx` must be: **validate GPS bounds → validate image size → call Vision API** — never hit the API on an invalid submission
- Halifax bounding box check is in `src/lib/validation.ts` — this is the first gate, keep it
- Budget alert recommended at GCP Billing → Budgets & alerts → $50 threshold

### Security
- `GOOGLE_VISION_API_KEY` is server-side only — NOT prefixed `NEXT_PUBLIC_`. Do not change this.
- API key is restricted to Cloud Vision API only in GCP console (`park-off` key) — do not broaden scope
- Do not log `raw_text` from sign submissions in production — it can contain location-identifying information

## Custom model training (AutoML Vision / Vertex AI) — planned by Ishant

### What "training" means here
The current implementation uses Google's **pre-trained** Vision OCR (TEXT_DETECTION). This requires no training data — it reads text from any image.

The planned training work is a **custom image classifier** to validate that a submitted photo is actually a parking sign before running OCR. This prevents garbage submissions (photos of people, buildings, etc.) from hitting the Vision API.

### How to train (Vertex AI AutoML Image Classification)
1. **Collect training images** — need ~100+ images per class minimum (ideally 300+):
   - Class `parking_sign`: photos of Halifax parking signs
   - Class `not_parking_sign`: random street photos, buildings, people, etc.
2. **Label the dataset** in Vertex AI → Datasets → Create → Image classification (single label)
3. **Upload images** to a GCS bucket in the same GCP project, then import into the dataset
4. **Train** via Vertex AI → Training → AutoML — typically takes 1-3 hours, costs ~$3-5 per training node hour
5. **Deploy** the model to an endpoint, or export as TFLite for on-device use
6. **Integrate**: call the classifier endpoint before `/api/analyse-sign` — reject if confidence < 0.85

### Training data collection strategy
- `SignCapture.tsx` already captures photos + GPS. Add a `is_valid_sign` boolean to the `sign_submissions` table.
- Admin dashboard (`/admin`) can be extended to let reviewers label submissions as valid/invalid — this builds the training dataset passively as the app gets used.
- Store labeled images in GCS bucket: `gs://park-off-training-data/parking_sign/` and `gs://park-off-training-data/not_parking_sign/`

### Key Vertex AI notes
- AutoML Vision is in **Vertex AI**, not the old Cloud AutoML console — use `console.cloud.google.com/vertex-ai`
- Model training requires billing to be enabled (not just free trial credits in some cases)
- TFLite export allows running inference on-device (in the browser via TensorFlow.js) to pre-filter before upload — good for cost reduction

## Type system (`src/lib/parking-rules.ts`)
Central module — import all parking types and helpers from here, never from route files.

Key types:
- `ParkingRule` — `{ rule_type, is_prohibited, days: number[]|null, time_window: {start,end}|null, tow_away, cost_per_hour, time_limit_minutes, permit_zone, raw_text }`
- `ExtractedParkingData` — `{ rules: ParkingRule[], raw_text, confidence, ...legacy fields }`
- `SpotSchedule` — `{ rules: ParkingRule[] }` — stored as JSONB in `parking_spots.schedule`

Key exports: `evaluateSpot(rules, now)`, `RULE_TYPE_COLOR`, `RULE_TYPE_LABEL`, `STATUS_COLOR`, `STATUS_LABEL`, `formatTimeWindow`, `formatDays`, `ruleLabel`, `deriveParkingType`, `haversineMetres`

## Supabase schema (current)
- `parking_spots` — live spots shown on map. Columns include `schedule JSONB` (stores `SpotSchedule`) alongside legacy flat columns.
- `sign_submissions` — raw community submissions awaiting admin review (image_path, latitude, longitude, device_metadata, extracted_data JSONB, status, reviewer_notes, submitted_at, parking_spot_id)
- Storage bucket: `parking-signs` (private) — submission images; signed URLs generated server-side via service role client

### Supabase clients
- `src/lib/supabase.ts` — public anon client for client-side use
- `src/lib/supabase-server.ts` — `createServiceRoleClient()` using `SUPABASE_SECRET_KEY` — server-side API routes only, bypasses RLS

### Env vars
```
NEXT_PUBLIC_MAPBOX_TOKEN
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
GOOGLE_VISION_API_KEY
```

## Admin dashboard (`/admin`)
- `src/app/admin/page.tsx` — server component wrapper
- `src/app/admin/AdminDashboard.tsx` — client component
- `src/app/api/admin/submissions/route.ts` — GET: lists all submissions + signed image URLs (service role)
- `src/app/api/admin/submissions/[id]/route.ts` — PATCH approve/reject. Approve: haversine check within 15 m for existing spot; merges `schedule.rules` if nearby spot exists, else creates new spot.
- **Not protected** — add Next.js middleware before launch

## Map (`src/components/map/ParkingMap.tsx`)
- Centered on downtown Halifax: `[-63.5788, 44.6476]`, zoom 14
- Fetches `schedule` column; `computeSpots(raw, now)` runs `evaluateSpot()` per spot → `current_status`, `current_color`, `current_label` stored as GeoJSON properties
- Circle layer color: `["get", "current_color"]` (data-driven, not a static match expression)
- Colors refresh every 5 minutes via `setInterval`
- Bottom sheet lists all rules from `spot.schedule.rules`, highlights active rule with "ACTIVE NOW" badge
- Geocoder restricted to HRM bounding box: `-64.5,44.3,-62.8,45.2`
## Supabase schema (current)
- `parking_spots` — live spots shown on map (id, latitude, longitude, parking_type, street_name, from_street, to_street, time_limit_minutes, cost_per_hour, notes)
- `sign_submissions` — raw community submissions awaiting admin review (id, image_path, latitude, longitude, device_metadata, extracted_data, status, reviewer_notes, submitted_at, parking_spot_id)
- Storage bucket: `parking-signs` — stores submission images

## Map (Mapbox)
- Centered on downtown Halifax: `[-63.5788, 44.6476]`, zoom 14
- Color coding: free=#16a34a, paid=#2563eb, permit=#d97706, accessible=#0ea5e9, unknown=#6b7280
- Geocoder restricted to HRM bounding box: `-64.5,44.3,-62.8,45.2`
- Uses GeoJSON source + circle layer (not individual markers) for performance

## What's not built yet
- User accounts / Supabase Auth
- Community verification (upvotes on spots)
- Admin route protection (currently open — add middleware before launch)
- Google Maps directions deep-link in marker popup
- Custom AutoML classifier for sign validation (pre-filter before OCR)
- Real HRM parking data import (script exists at `scripts/importParkingData.js`, hasn't been run against prod)

<!-- END:project-context -->

## Imported Claude Cowork project instructions

This project is by me and Ishant jethi
never commit anything that says co-authored with claude,
