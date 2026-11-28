# Park Off

Park Off is a community-powered parking map for Halifax, Nova Scotia. Gavin Sharma and Ishant Jethi maintain the project.

## Before editing

- This project uses Next.js 16 and the App Router. Read the relevant guide in `node_modules/next/dist/docs/` before writing code.
- Use the current source and migrations as the reference for application behavior and database constraints.
- Keep commit messages concise and omit AI attribution trailers. Avoid em dashes in project text.

## Application flow

- `/submit` captures a sign photo and checks that the coordinates are in Halifax.
- `/api/analyse-sign` and `/api/can-i-park` apply Upstash rate limits and validate image payloads before Gemini. Keep `GEMINI_API_KEY` server-side and avoid logging extracted sign text in production.
- `src/lib/parking-rules.ts` defines parking rules and evaluates them in Halifax time by default. Import parking types from this module.
- Supabase stores sign photos in the private `parking-signs` bucket. Generate signed URLs on the server and use the service role only in server-side code.
- The admin dashboard reviews submissions before publishing spots. `/admin` and its protected API routes require a valid admin session.
- The Mapbox map uses a GeoJSON source and reevaluates current parking restrictions every five minutes. Demo spots are labeled when the live dataset is empty or unavailable.
