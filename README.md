# Clean Air Atlas

A personal, non-commercial map of live air quality around the world, with a simulator
(coming) that estimates how much cleaner the air gets when solar plus battery storage
replaces fossil power.

The site is static. A scheduled GitHub Actions workflow fetches the data, builds the
site and deploys it to GitHub Pages. No API is called from the browser.

## What is live now

- Measuring stations reporting PM2.5 in the last 6 hours (OpenAQ), drawn on a dark
  globe and coloured against the WHO 2021 24-hour guideline and interim targets.
- Click a station for its latest reading, how it compares with the WHO level, when it
  was measured, who provides the data and its last 72 hours.
- NO₂ stations as well as PM2.5 (OpenAQ ppm values converted with the WHO factor).
- A time slider over the last 72 hours of measurements plus the CAMS model forecast
  (surface PM2.5, five days ahead), shaded where it is above the WHO guideline.

## Run it locally

```bash
npm --prefix web ci
OPENAQ_API_KEY=... python3 -m pipeline.build_stations --out web/public/data
npm --prefix web run dev
```

Without a key the map loads but shows "No station data".

## Tests

```bash
pip install -r pipeline/requirements.txt -r pipeline/requirements-dev.txt
python3 -m pytest
npm --prefix web run typecheck
npm --prefix web test
```

## Set-up on GitHub

1. Repository secret `OPENAQ_API_KEY` (free key from https://explore.openaq.org/register).
   Optional secret `ADS_API_KEY`: a personal access token from the Atmosphere Data Store
   (https://ads.atmosphere.copernicus.eu). Accept the licence on the
   "CAMS global atmospheric composition forecasts" download form once, or every request
   fails. Without this secret the map simply has no model layer.
2. Settings → Pages → Source: GitHub Actions.
3. The workflow runs on every push to `main` and every hour.

The 72-hour history is not stored in git. Each run copies it back from the live site,
adds the new hour and prunes the oldest. CAMS is only requested when a newer model run
is due (00 UTC run after 10:00 UTC, 12 UTC run after 22:00 UTC).

If a fetch fails, the workflow redeploys the last good data from the live site and
marks the run as failed, so the map never goes blank and the failure is visible.

## Data and credits

- Air quality: [OpenAQ](https://openaq.org) and its data providers (listed in the site).
- Forecast: contains modified Copernicus Atmosphere Monitoring Service information
  (CAMS global atmospheric composition forecasts, CC BY 4.0).
- Guideline levels: WHO global air quality guidelines, 2021 (ISBN 9789240034228).
- Base map: [OpenFreeMap](https://openfreemap.org) © OpenMapTiles, data © OpenStreetMap
  contributors. Fallback style: VersaTiles.

See `CLAUDE.md` for the project rules and build plan.
