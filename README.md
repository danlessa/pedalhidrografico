# pedalhidrografico

Static web app: an OpenStreetMap with the Pedal Hidrográfico hydrography
overlay, every route from the project's Google Sheet drawn on top of it,
filterable by date, with the linked Instagram post embedded on click. Includes
an in-browser GPX drawing tool.

## What it does

- OpenStreetMap base + custom hydrography overlay
  (`https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png`), togglable
  via the layer control.
- Renders every route from the "Geral" sheet's `Rota` column in white with a
  dark casing, labelled by `Data — Nome`.
- Numbered overlay per route (plain text + halo) using the first non-empty,
  non-`-` value from `PH → BT → BP → S`.
- Sidebar sorted by `Data` descending. Date-window slider filters in real time.
- Click a route → modal embedding the linked Instagram post (`Post IG` column).
- **Traçar GPX** button: click the map to drop trackpoints, drag them to move,
  Undo/Redo (also ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z), then **Salvar GPX** downloads
  a `.gpx` file. Esc cancels.

## Architecture

It's a fully static site. There are two stages:

1. **Build step (Node, with credentials).** `scripts/build-routes.mjs` reads
   the Google Sheet via the `gviz` JSON endpoint, then fetches every route's
   GPX from RideWithGPS using your API credentials, downsamples each track to
   ≤400 points, and writes everything into `public/routes.json`. This is the
   only place RWGPS credentials are needed — the browser never sees them.

2. **Runtime (browser only).** `public/index.html` loads `routes.json` and
   does everything from there. No backend required at runtime; serve `public/`
   from any static host.

## Run it

```bash
npm install
cp .env.example .env
# fill in RWGPS_API_KEY and RWGPS_AUTH_TOKEN — see "Credentials" below

npm run build:routes        # writes public/routes.json
```

Then serve `public/` with anything:

```bash
cd public && python3 -m http.server 8000
# open http://localhost:8000/
```

Node 18+ required for the build step (uses built-in `fetch`).

Re-run `npm run build:routes` whenever the sheet has new entries.

### Static deploy

After `npm run build:routes`, `public/` is fully self-contained. Push it to
GitHub Pages, Netlify, S3, etc. and you're done — no server needed.

## Credentials

`.env` is gitignored. The build step (`npm run build:routes`) is the only
thing that touches credentials.

- `RWGPS_API_KEY` — request one at <https://ridewithgps.com/api>.
- `RWGPS_AUTH_TOKEN` — auth token for the user account that owns the routes.
  You can get it by `POST`ing email+password to
  `https://ridewithgps.com/users/current.json` (response includes
  `user.auth_token`), or from your account settings page.
- `RWGPS_COLLECTION_PRIVACY_CODE` — set if some routes are unlisted and need
  the collection privacy code.

## Sheet columns used by the build script

`scripts/build-routes.mjs` reads these columns from the `Geral` sheet
(case-insensitive header match):

| Column | Use |
| --- | --- |
| `Rota` | RideWithGPS URL or numeric ID. Required. |
| `Data` | Display label + sort key. Parsed as a real date for the slider. |
| `Nome` | Display label. |
| `Post IG` | Instagram URL (post / reel / IGTV). Embedded in modal on click. |
| `PH`, `BT`, `BP`, `S` | Route number. First non-empty, non-`-` value wins, in that order. |

## Caveats

- **Instagram embeds only work for public posts.** Private-account posts won't
  render in the iframe — the modal falls back to a "View on Instagram ↗" link.
- **`public/routes.json` is gitignored** so credentials-derived data isn't
  committed by accident. To deploy via GitHub Pages without a build server,
  remove it from `.gitignore` and commit the JSON.
- **The Traçar GPX tool produces a bare track** (no elevation, no per-point
  timestamps — there's no real source for those when drawing from scratch).
  Most platforms (RWGPS, Strava, Komoot) will fill in elevation server-side
  on upload.
