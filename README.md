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
  (PM2.5 and NO₂, five days ahead), shaded where it is above the WHO guideline.
  CAMS has no surface NO₂ field, so the NO₂ layer takes the lowest model level and
  converts it to µg/m³ with air density from surface pressure and 2 m temperature:
  an approximation, and labelled as one on the map.
- Animated 10 m wind from NOAA GFS (updated every run, no account needed). Still
  streamlines instead of animation when the system asks for reduced motion.
- A phone layout: legend behind a button, station details in a bottom sheet, one-line
  credits with the full licence wording in the Sources dialog.
- Grid mix: each country's electricity by source (Ember, 2016 to the latest year), the
  map shaded by fossil share or by wind and solar share.
- Simulator: replace diesel generators, a generic fossil plant or the grid average with
  solar and storage, and see the fossil MWh displaced, tonnes of NOx, SO2 and PM2.5
  avoided and the damage avoided, each as a low, central and high range. Lagos diesel
  generator preset included.
- Methods page generated from `data/static/`, listing every number's source.

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
is due (00 UTC run after 10:00 UTC, 12 UTC run after 22:00 UTC). That is one ADS
request for PM2.5 and two for NO₂ (the model-level field, then surface pressure and
2 m temperature), sharing one time budget. Each layer keeps its own frames if its
requests fail.

If a fetch fails, the workflow redeploys the last good data from the live site and
marks the run as failed, so the map never goes blank and the failure is visible.

## Hand-refreshed inputs

These live in `data/static/` with their sources and are refreshed by hand, not by the
hourly workflow:

```bash
python3 -m pipeline.ember     # Ember yearly electricity data -> ember_electricity.json
python3 -m pipeline.pvgis     # PVGIS solar profiles -> pv_profiles.json
```

Emission factors, efficiencies, damage costs, the GBP/EUR rate and battery defaults are
curated by hand from the sources named in each file.

## Data and credits

- Air quality: [OpenAQ](https://openaq.org) and its data providers (listed in the site).
- Forecast: contains modified Copernicus Atmosphere Monitoring Service information
  (CAMS global atmospheric composition forecasts, CC BY 4.0): surface PM2.5, and NO₂ on
  the lowest model level with surface pressure and 2 m temperature.
- Gas constant for dry air (NO₂ conversion): ECMWF, IFS Documentation Cy47r3, Part IV:
  Physical Processes (2021), section 12.5 (CC BY 4.0).
- Wind: NOAA NCEP Global Forecast System via NOAA Open Data Dissemination on AWS.
- Electricity mix: Ember, Yearly Electricity Data (CC BY 4.0).
- Solar: PVGIS © European Communities, 2001-2026 (EU Joint Research Centre).
- Emission factors: EMEP/EEA air pollutant emission inventory guidebook 2023; US EPA AP-42;
  World Bank (2014). Damage costs: EEA (2024, EUR 2021 prices); Defra (2025, GBP 2025 prices).
- Country shapes: Natural Earth (public domain) via world-atlas.
- Guideline levels: WHO global air quality guidelines, 2021 (ISBN 9789240034228).
- Base map: [OpenFreeMap](https://openfreemap.org) © OpenMapTiles, data © OpenStreetMap
  contributors. Fallback style: VersaTiles.

See `CLAUDE.md` for the project rules and build plan.
