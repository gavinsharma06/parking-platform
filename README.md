# Park Off

Community powered parking discovery for Halifax, Nova Scotia.

Find free parking, paid parking, street parking, and community verified spots on a live map.

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI | React 19.2, Tailwind CSS v4 |
| Language | TypeScript |
| Map | Mapbox GL JS v3 |
| Database | Supabase (planned) |
| OCR | Google Vision API (planned) |

## Prerequisites

- Node.js 20.9 or higher ([download](https://nodejs.org/))
- npm (comes with Node.js)
- A free Mapbox account for the map token ([sign up](https://account.mapbox.com/auth/signup/))

## Getting started

### 1. Clone the repo

```bash
git clone <repo-url>
cd parking-platform
```

### 2. Install dependencies

```bash
npm install
```

This installs everything from `package.json`. The `node_modules` folder is gitignored so it is not in the repo.

### 3. Set up environment variables

```bash
cp .env.example .env
```

Open `.env` and replace the placeholder with your real Mapbox token:

```
NEXT_PUBLIC_MAPBOX_TOKEN=pk.your_actual_token_here
```

Get a token from [account.mapbox.com/access-tokens](https://account.mapbox.com/access-tokens/). Public tokens start with `pk.`. The `.env` file is gitignored so you will never accidentally commit a real token.

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_MAPBOX_TOKEN` | Yes | Mapbox public token. Must start with `pk.` |
| `CRON_SECRET` | Production | Random string of 32+ characters. Protects `/api/health` |
| `NEXT_PUBLIC_PARKING_TIME_ZONE` | No | IANA timezone the parking rules are evaluated in. Defaults to `America/Halifax` |
| `GEMINI_API_KEY` | Yes | Google Gemini API key used to read sign photos. Server only |
| `GEMINI_MODEL` | No | Gemini model used to read signs. Defaults to `gemini-3.5-flash-lite` |
| `GEMINI_THINKING_LEVEL` | No | `minimal`, `low`, `medium` or `high`. Defaults to `low` |
| `GEMINI_TIMEOUT_MS` | No | Timeout for one Gemini request in milliseconds. Defaults to `30000` |

Parking rules are always evaluated in `NEXT_PUBLIC_PARKING_TIME_ZONE`, on the server and in the browser, so the answer does not depend on where the server runs or where the visitor is.

The model name is set in one place, `src/lib/gemini.ts`. To move to a different model, set `GEMINI_MODEL` rather than editing code, and first check that it still reads the sample signs in `parkingsigns/` (one billable API call per image):

```bash
GEMINI_LIVE_TEST=1 GEMINI_API_KEY=your_key GEMINI_MODEL=new-model npm test -- gemini.live
```

### AI endpoint limits

`/api/submissions` and `/api/can-i-park` are the only routes that call the AI model or store photos. Each request passes these gates in order, and stops at the first one it fails:

1. **Rate limit** per IP (or per admin), through Upstash
2. **Size**: body and decoded image size caps; the image must be a JPEG
3. **Location**: coordinates must be inside the Halifax Regional Municipality
4. AI call, then storage

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required in production: without them these routes return `503` instead of running unlimited. In local development and on preview deployments they run without limits and log a warning.

Browsers never write to Supabase directly. Photos and `sign_submissions` rows are created by the server with the service role, and the migration `20261113000000_server_only_submissions.sql` removes the anonymous insert policies. Run that migration only after this version of the app is deployed.

Every limit has a default and can be overridden per environment:

| Variable | Default | Description |
|---|---|---|
| `AI_RATE_LIMIT_PER_MINUTE` | `10` | Requests per minute per IP, per route |
| `AI_RATE_LIMIT_PER_DAY` | `50` | Requests per day per IP, per route |
| `AI_ADMIN_RATE_LIMIT_PER_MINUTE` | `60` | Requests per minute for a logged-in admin |
| `AI_ADMIN_RATE_LIMIT_PER_DAY` | `500` | Requests per day for a logged-in admin |
| `AI_MAX_BODY_BYTES` | `4194304` | Largest request body accepted (4 MB) |
| `AI_MAX_IMAGE_BYTES` | `3145728` | Largest decoded image accepted (3 MB) |

### Cost and abuse checklist

These are set in each provider's dashboard, not in code. Confirm them before sharing the app publicly:

- [ ] Vercel production has `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` pointing at a live Upstash database
- [ ] Google AI Studio / Google Cloud: budget alert on the project that owns `GEMINI_API_KEY`
- [ ] Supabase: spend cap on, and usage alerts for database size and storage
- [ ] Vercel: spend management limit and usage notifications
- [ ] Upstash: daily request budget on the rate-limit database
- [ ] Mapbox: token restricted to the production URL, and a usage alert
- [ ] Migration `20261113000000_server_only_submissions.sql` applied to the production database

When you add a new variable: add a placeholder line to `.env.example` and update this table. That way the next person to clone the repo knows exactly what they need.

## Keep alive

Supabase pauses free projects after about a week with no activity. A Vercel Cron job (see `vercel.json`) calls `/api/health` once a day at 09:00 UTC, which runs one small read against the database so the project stays active.

The endpoint only answers requests that send `Authorization: Bearer <CRON_SECRET>`. Vercel sends this header automatically on cron calls, but only if `CRON_SECRET` is set in the Vercel project's environment variables. Without it, every call returns `401` and the database will still pause.

## Project structure

```
src/
  app/
    layout.tsx          Root HTML shell and metadata
    page.tsx            Homepage
    globals.css         Global styles and Tailwind entry point
  components/
    layout/
      Navbar.tsx        Top navigation bar
    map/
      ParkingMap.tsx    Mapbox GL JS map (client component)
      ParkingMarker.tsx Individual parking markers (in progress)
    capture/            Future: camera and sign photo submission
    parking/            Future: parking spot cards and details
  lib/                  Future: API helpers and utilities
  types/                Future: shared TypeScript types
```

## Available scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the dev server with Turbopack |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm run lint` | Run ESLint |

## Current status

The homepage is a UI preview. No backend is connected yet.

What is working:
- Homepage with hero, map preview, how it works, and contribution sections
- Live Mapbox map centered on downtown Halifax
- Navbar with placeholder links

What is planned:
- Real parking spot data from Supabase
- Parking markers on the map (free, paid, restricted)
- Parking sign photo upload with Google Vision OCR
- Community verification flow
- User accounts

## Contributors

- Gavin Sharma
- Ishant
