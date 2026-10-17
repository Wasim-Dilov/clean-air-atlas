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
  was measured and who provides the data.

## Run it locally

```bash
npm --prefix web ci
OPENAQ_API_KEY=... python3 -m pipeline.build_stations --out web/public/data
npm --prefix web run dev
```

Without a key the map loads but shows "No station data".

## Tests

```bash
python3 -m pytest
npm --prefix web run typecheck
npm --prefix web test
```

## Set-up on GitHub

1. Repository secret `OPENAQ_API_KEY` (free key from https://explore.openaq.org/register).
2. Settings → Pages → Source: GitHub Actions.
3. The workflow runs on every push to `main` and every hour.

If a fetch fails, the workflow redeploys the last good data from the live site and
marks the run as failed, so the map never goes blank and the failure is visible.

## Data and credits

- Air quality: [OpenAQ](https://openaq.org) and its data providers (listed in the site).
- Guideline levels: WHO global air quality guidelines, 2021 (ISBN 9789240034228).
- Base map: [OpenFreeMap](https://openfreemap.org) © OpenMapTiles, data © OpenStreetMap
  contributors. Fallback style: VersaTiles.

See `CLAUDE.md` for the project rules and build plan.
