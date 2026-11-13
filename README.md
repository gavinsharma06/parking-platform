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

### AI endpoint limits

`/api/analyse-sign` and `/api/can-i-park` are rate limited through Upstash and reject oversized images before any AI call. `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required in production: without them these routes return `503` instead of running unlimited. In local development and on preview deployments they run without limits and log a warning.

Every limit has a default and can be overridden per environment:

| Variable | Default | Description |
|---|---|---|
| `AI_RATE_LIMIT_PER_MINUTE` | `10` | Requests per minute per IP, per route |
| `AI_RATE_LIMIT_PER_DAY` | `50` | Requests per day per IP, per route |
| `AI_ADMIN_RATE_LIMIT_PER_MINUTE` | `60` | Requests per minute for a logged-in admin |
| `AI_ADMIN_RATE_LIMIT_PER_DAY` | `500` | Requests per day for a logged-in admin |
| `AI_MAX_BODY_BYTES` | `4194304` | Largest request body accepted (4 MB) |
| `AI_MAX_IMAGE_BYTES` | `3145728` | Largest decoded image accepted (3 MB) |

When you add a new variable: add a placeholder line to `.env.example` and update this table. That way the next person to clone the repo knows exactly what they need.

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
