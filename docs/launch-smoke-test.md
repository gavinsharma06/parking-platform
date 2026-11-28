# Park Off launch smoke test

Record the deployment, commit, date, device and result when running these checks. Use an approved field submission for the last check.

| Check | Expected result |
| --- | --- |
| `/` | Map loads, a marker opens with the expected restrictions, and sample spots are clearly labeled if live data is unavailable. |
| `/submit` | The page loads on a phone. Declining camera or location access gives a clear error and a way to retry. |
| `/can-i-park` | The page loads and offers camera or image input. An empty API request is rejected before any model call. |
| `/admin` | A signed-out visitor is redirected to `/admin/login`. An admin can sign in and view both tabs. |
| `/api/admin/*` | Logged-out requests to `/api/admin/spots` and `/api/admin/submissions` return `401`. The login endpoint remains reachable. |
| One real mobile submission | Photograph a real sign outdoors in Halifax. Check that camera and GPS work, compare the saved location with the pole, review the extracted rules in admin, and confirm the approved spot appears on the map. |

Use GitHub CI for lint, tests, TypeScript and the build. Keep Vercel previews for deployed behavior and device checks.
