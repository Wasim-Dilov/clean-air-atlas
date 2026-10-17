# Clean Air Atlas

Personal, non-commercial side project: a live global air quality map, each country's
electricity mix, and a simulator showing how much cleaner the air gets when solar plus
battery storage (BESS) replaces fossil power. This file holds the rules.

## Hard rules

- Personal and non-commercial. No employer or company names, logos or branding anywhere,
  and no commercial product references. Refer to battery storage generically as BESS.
- Zero cost. Free tiers only. Ask before adding any paid service, paid API or account.
- Only permissive open-source dependencies (MIT, BSD, ISC, Apache 2.0). Check the
  licence before adding one.
- Never commit secrets. API keys live in GitHub repository secrets and reach the code
  as environment variables.
- Never call OpenAQ (or any keyed API) from the browser. All third-party calls happen
  in the pipeline.
- Never commit generated data. The workflow builds data and deploys it as a Pages
  artifact, so the repository stays small.
- Credit every data source in the site footer, using the wording each licence asks for.
- No invented numbers. Every emission factor, damage cost, efficiency and exchange rate
  lives in a file under data/static/ with its source, year and units. If a value cannot
  be sourced, stop and ask.
- Show simulator results as ranges (low, central, high), never one headline number.
- Keep the deployed site well under 1 GB: 72 hours of history, coarse grids.

## Stack

- Public GitHub repository (Actions is free for public repos).
- Hosting: GitHub Pages, deployed from Actions.
- Front end: Vite + TypeScript, MapLibre GL JS, OpenFreeMap base map
  (style URL: https://tiles.openfreemap.org/styles/liberty), deck.gl where it helps.
- Pipeline: Python 3, run by scheduled GitHub Actions workflows.
- Tests: pytest for the pipeline, Vitest for the simulator.

## Layout

```
pipeline/            Python fetch-and-convert scripts
web/                 Vite + TypeScript front end
web/src/sim/         simulator engine (pure functions, no DOM)
data/static/         small hand-curated inputs committed to git:
                     emission factors, damage costs, FX rate, presets, GEM extract
.github/workflows/   build-and-deploy workflow(s)
```

## Data sources

| Source | Used for | Access | Notes |
| --- | --- | --- | --- |
| OpenAQ v3 | Station PM2.5 and NO2 | Free key, secret `OPENAQ_API_KEY` | Non-commercial; pipeline only |
| Copernicus CAMS global forecasts | Model fill and forecast, surface PM2.5 and NO2 | Atmosphere Data Store API (`cdsapi`), secret `ADS_API_KEY` | New runs twice a day, so fetch twice a day, not hourly. Copernicus attribution wording required |
| NOAA GFS | 10 m wind (U and V) for the animation | NOAA open data on AWS, no account | Public domain; a 1 degree grid is enough |
| Ember | Country electricity mix | CC BY 4.0 download | Yearly data; refresh by hand |
| Global Energy Monitor | Coal plant locations and capacity | Manual download, CC BY 4.0 | Commit a trimmed CSV with attribution |
| PVGIS (EU JRC) | Hourly PV output profiles | Free API, called from the pipeline | Precompute one typical-year profile per preset site and per country |

Look up current endpoints, dataset names and variable names in each provider's docs
rather than guessing them.

Left out on purpose: WAQI (forbids caching, which a static site needs), Electricity
Maps and Google Air Quality (not needed for version 1).

## Simulator method

Chain: displaced fossil MWh, then emissions avoided (tonnes a year per pollutant),
then damage avoided (EUR a year, as a range).

1. Displaced source: grid average (Ember mix with per-fuel emission factors), a named
   plant, or N diesel generators of a given size and running hours.
2. Solar: PVGIS hourly profile multiplied by MW installed.
3. Storage: hourly dispatch that moves midday surplus into the evening and night.
   Inputs: power (MW), energy (MWh), round-trip efficiency, usable depth of discharge.
   Never exceed power limits or leave the allowed state-of-charge window.
4. Emissions avoided: displaced MWh multiplied by emission factors per pollutant
   (EMEP/EEA guidebook; US EPA AP-42 for diesel generators).
5. Damage avoided: tonnes multiplied by damage cost per tonne. EEA values (EUR, 2021
   prices) for Europe; Defra 2025 values (GBP) for the UK. Convert GBP to EUR with a
   dated rate stored in data/static/fx.json, and show the original currency and price
   year on the methodology page.
6. Outside Europe there are no official damage costs. Show tonnes avoided first and
   label any EUR figure as a rough transfer from European values.

Say plainly in the UI that gains are small where the grid is already clean.

## Validation (run on every change)

- Dispatch tests: hourly energy balance closes within 0.1%, state of charge stays in
  bounds, storage never charges from fossil generation.
- Conversion tests: MWh, tonnes and GBP to EUR, including a check that every damage
  cost row declares its currency and price year.
- A golden test for the Lagos preset so its numbers cannot drift unnoticed.
- Pipeline checks: drop station values outside plausible ranges, log counts per run,
  and fail loudly rather than publish an empty layer. Keep the last good frame if a
  fetch fails.
- Run all tests before every commit. The workflow runs them before deploying.

## Build order

Work one block at a time. Finish and demo each block before starting the next.

1. **Weekend 1, map basics.** Repo skeleton, Vite app with the OpenFreeMap base map,
   a pipeline script that pulls the latest OpenAQ PM2.5 into a JSON file, stations
   drawn as dots coloured against the WHO guideline, attribution footer, and a working
   deploy to GitHub Pages. Done when the live URL shows stations on a phone.
2. **Weekends 2 to 3, model and forecast.** Scheduled workflow (OpenAQ hourly, CAMS
   twice a day), CAMS converted to a coarse global raster overlay, a time slider
   covering 72 hours of history plus the forecast, old frames pruned. Done when it has
   updated itself for 48 hours without help.
3. **Weekend 4, wind and polish.** GFS 10 m wind as animated particles (custom WebGL
   layer or a permissively licensed plugin) and a proper mobile layout. Done when it
   runs smoothly on a mid-range phone.
4. **Weekends 5 to 8, simulator.** Engine with tests in web/src/sim, grid-average mode
   for any country, the Lagos diesel generator preset, a results panel with ranges and
   a methodology page listing every source. Done when all tests pass and every number
   on screen traces back to a source row.

Grid mix view (Ember country electricity mix by source, map shaded by fossil share)
can ship alongside block 4, since the simulator's grid-average mode uses the same data.

## Working style

- Start each block in plan mode: propose the plan, wait for approval, then build.
- Small commits with clear messages.
- Plain, short UI copy. Label model estimates as estimates.
- Visual design reference: the Clean Air Atlas canvas in Claude Design. Dark,
  monochrome UI; colour is reserved for data. No glassy blur, glow or gradient chrome.

## Gotchas

- GitHub disables scheduled workflows in public repos after 60 days with no repository
  activity. Keep at least one commit a month, or re-enable the workflow.
- GitHub Pages soft limits: about 100 GB of traffic a month and 10 builds an hour.
  Deploy at most once an hour.
- Atmosphere Data Store requests can sit in a queue. Time out gracefully and keep the
  previous frame.
- OpenFreeMap is donation-funded. Keep a fallback base map style in config.
