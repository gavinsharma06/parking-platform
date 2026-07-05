# Park Off One-Week Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Park Off safe enough for a one-week public beta push, collect new Halifax street data, and prepare for a low-key LinkedIn launch.

**Architecture:** Treat this as a launch-hardening track, not a rewrite. Lock down admin/API access, unblock the current Vercel production deploy, control AI/storage costs, validate GPS and multi-sign parsing with field data, then run a repeatable smoke test before posting.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind v4, Mapbox GL JS, Supabase, Gemini Vision, Upstash rate limiting, Vercel, GitHub Issues.

---

### Task 1: Production Deploy Recovery

**Files:**
- Inspect: `package.json`
- Inspect: `src/app/layout.tsx`
- Inspect: `src/middleware.ts`
- Track: GitHub issue #9

- [ ] **Step 1: Confirm Vercel blocked deployment reason**

Open Vercel project `parking-platform` under team `demented-diablos-projects` and inspect deployment `dpl_6RVnJNsKVzeUntuheVJRhaEMRuXQ`.

Expected: identify whether the block is caused by billing, deployment protection, missing env vars, build failure, or project settings.

- [ ] **Step 2: Verify production env vars**

Confirm these exist in Vercel production without exposing values:

```text
NEXT_PUBLIC_MAPBOX_TOKEN
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
GEMINI_API_KEY
ADMIN_GAVIN_PASSWORD
ADMIN_ISHANT_PASSWORD
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

- [ ] **Step 3: Redeploy current main**

Deploy commit `230cf0704e1444700d04212526ba693c64126665` or newer.

Expected: production deployment state is `READY`.

- [ ] **Step 4: Smoke test production routes**

Run:

```powershell
$paths=@('/','/submit','/can-i-park','/admin','/admin/login')
foreach($p in $paths){ Invoke-WebRequest -Uri "https://parking-platform-alpha.vercel.app$p" -MaximumRedirection 0 -UseBasicParsing }
```

Expected:
- `/` returns `200`
- `/submit` returns `200`
- `/can-i-park` returns `200`
- `/admin` redirects to `/admin/login`
- `/admin/login` returns `200`

### Task 2: Admin/API Security

**Files:**
- Modify: `src/middleware.ts`
- Modify: `src/app/api/admin/auth/route.ts`
- Inspect: `src/app/api/admin/submissions/route.ts`
- Inspect: `src/app/api/admin/submissions/[id]/route.ts`
- Inspect: `src/app/api/admin/spots/route.ts`
- Inspect: `src/app/api/admin/spots/[id]/route.ts`
- Track: GitHub issue #33

- [ ] **Step 1: Add failing unauthorized API checks**

Add a smoke test or manual checklist entry proving logged-out requests to `/api/admin/submissions` do not return data.

Expected before fix: live beta currently returns `200`.

- [ ] **Step 2: Protect admin API routes**

Update route matching to cover both:

```text
/admin
/admin/:path*
/api/admin/:path*
```

- [ ] **Step 3: Replace plaintext password cookie**

Replace `${username}:${password}` cookies with a signed session token. Use a server-side secret and compare signatures, not raw passwords.

- [ ] **Step 4: Verify admin behavior**

Expected:
- Logged-out admin API calls return `401` or redirect-equivalent failure.
- Logged-in admin can review submissions.
- Cookies do not contain plaintext passwords.

### Task 3: Abuse And Cost Controls

**Files:**
- Modify: `src/app/api/analyse-sign/route.ts`
- Modify: `src/app/api/can-i-park/route.ts`
- Modify: `src/components/capture/SignCapture.tsx`
- Modify: `src/components/parking-check/ParkingCheck.tsx`
- Track: GitHub issue #34

- [ ] **Step 1: Confirm rate limits are active in production**

Check that Upstash env vars are set in Vercel production.

Expected: `/api/analyse-sign` uses per-minute and per-day limits.

- [ ] **Step 2: Add rate limiting to `/api/can-i-park`**

Reuse the existing `getRateLimitMinute()` and `getRateLimitDay()` helpers before calling Gemini.

- [ ] **Step 3: Reject oversized image payloads**

Set a conservative maximum request body/image size before AI calls.

Expected: oversized inputs return `413` or `400` and do not call Gemini.

- [ ] **Step 4: Confirm budgets**

Configure alerts for Gemini/GCP, Supabase, Vercel, Upstash, and Mapbox.

### Task 4: GPS Accuracy

**Files:**
- Modify: `src/components/capture/SignCapture.tsx`
- Modify: `src/components/parking-check/ParkingCheck.tsx`
- Modify: `src/lib/submissions.ts`
- Track: GitHub issue #35

- [ ] **Step 1: Store GPS accuracy**

Add `accuracyMetres: pos.coords.accuracy` to `device_metadata`.

- [ ] **Step 2: Show accuracy before submit**

Display the captured location and accuracy.

Expected: users can see when GPS is poor.

- [ ] **Step 3: Add poor-accuracy warning**

Warn or require retry when accuracy is worse than the selected threshold, such as `25m`.

- [ ] **Step 4: Field test**

Collect at least 10 outdoor submissions and record observed GPS accuracy.

### Task 5: Multi-Sign Parser Validation

**Files:**
- Inspect: `src/app/api/analyse-sign/route.ts`
- Inspect: `src/lib/training-examples.ts`
- Inspect: `src/lib/parking-rules.ts`
- Inspect: `src/app/admin/AdminDashboard.tsx`
- Track: GitHub issue #36

- [ ] **Step 1: Build a test photo set**

Use existing `parkingsigns/` images plus at least 20 new field photos with multi-panel signs where possible.

- [ ] **Step 2: Compare expected vs actual rules**

For each image, record:

```text
expected rule count
actual rule count
time windows
days
direction
confidence
reviewer decision
```

- [ ] **Step 3: Seed approved examples**

After admin approval, confirm useful examples appear in `training_examples`.

- [ ] **Step 4: File parser bugs**

Create follow-up issues for repeated extraction failures.

### Task 6: Field Data Collection Runbook

**Files:**
- Create: `docs/field-data-collection.md`
- Track: GitHub issue #37

- [ ] **Step 1: Assign zones**

Split first-pass zones between Gavin and Ishant:

```text
Downtown core
Spring Garden / South Park
Dalhousie / University
Waterfront
Hospital area
Residential permit streets
```

- [ ] **Step 2: Define capture rules**

Document:
- one pole per submission
- include all sign panels
- retake blurry/angled shots
- stand near the sign pole
- avoid people/license plates where possible

- [ ] **Step 3: Define review cadence**

Review same day. Summarize collected, approved, rejected, merged, and parser-failed counts.

### Task 7: Launch Quality Gate

**Files:**
- Modify: `package.json`
- Modify: `src/app/admin/AdminDashboard.tsx`
- Modify: `src/components/layout/Navbar.tsx`
- Modify: `src/app/page.tsx`
- Create: `.github/workflows/ci.yml`
- Track: GitHub issue #38

- [ ] **Step 1: Fix lint errors**

Run:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run lint
```

Expected: `0` errors.

- [ ] **Step 2: Add test script**

Install/configure the selected test runner and add:

```json
"test": "vitest run"
```

- [ ] **Step 3: Add GitHub Actions CI**

CI should run install, lint, tests, and build on PRs.

- [ ] **Step 4: Final production smoke test**

Before LinkedIn post, verify:
- map loads
- live spots render
- submit flow works on phone
- can-i-park flow works on phone
- admin review works
- logged-out API access is blocked
- rate limits are active

### Task 8: Docs And Schema Drift

**Files:**
- Modify: `README.md`
- Modify: `scripts/run-ocr-batch.js`
- Modify: `supabase/migrations/20260423000000_initial_schema.sql` or create a new migration
- Track: GitHub issue #39

- [ ] **Step 1: Update README status**

README should reflect the current app: Supabase, Gemini, admin dashboard, sign submissions, and Can I Park Here.

- [ ] **Step 2: Document env vars**

Document all required variables without exposing secret values.

- [ ] **Step 3: Add `training_examples` migration**

Ensure migrations define every table used by app code.

- [ ] **Step 4: Update batch OCR script**

Either convert it to Gemini or mark it as legacy Google Vision tooling.

---

## Launch Decision Rule

Do not post publicly until issues #9, #33, #34, #35, #36, #37, and #38 are closed or explicitly accepted as known beta limitations. Issue #39 can trail the launch only if the app is already secure, deployed, and tested.
