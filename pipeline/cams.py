"""CAMS global forecast of surface PM2.5 and NO2, as coloured Mercator images for the time slider.

    ADS_API_KEY=... python -m pipeline.cams --out web/public/data

Runs every hour but only calls the ADS when a newer model run should be out
(00 UTC run by 10:00 UTC, 12 UTC run by 22:00 UTC). Without a key, or if the ADS
times out, the frames already pulled from the live site are kept.

PM2.5 comes as a surface concentration (kg m-3). NO2 has no surface field in this
dataset, so it is taken on the lowest model level (137) as a mass mixing ratio
(kg/kg) and multiplied by dry-air density from surface pressure and 2 m
temperature: an approximation, labelled as such on the map.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from . import ads, grib, png, raster, static
from .history import hour_floor, iso, parse_iso, read_json, stamp, write_json

log = logging.getLogger("cams")

DATASET = "cams-global-atmospheric-composition-forecasts"
LEADS = list(range(0, 121, 3))  # 3-hourly to 5 days
KEEP_PAST = timedelta(hours=72)
IMAGE_SIZE = 512
PARAMETERS = ("pm25", "no2")

PM25_VARIABLES = ["particulate_matter_2.5um"]
NO2_VARIABLES = ["nitrogen_dioxide"]
NO2_MODEL_LEVEL = "137"  # lowest model level, nearest the ground
MET_VARIABLES = ["surface_pressure", "2m_temperature"]

# Must match PM25_RAMP and NO2_RAMP in web/src/bands.ts (a test checks this).
PM25_RAMP = ["#a83902", "#d24903", "#f5642b", "#ff936d", "#ffc0ab", "#fee5dc"]
NO2_RAMP = ["#a83902", "#f5642b", "#ffc0ab", "#fee5dc"]
# The band that meets the WHO guideline stays clear, so the haze shows only exceedance.
PM25_ALPHAS = [0, 95, 125, 150, 175, 195]
NO2_ALPHAS = [0, 125, 175, 195]  # each colour keeps the alpha it has in the PM2.5 ramp
STYLE = {"pm25": (PM25_RAMP, PM25_ALPHAS), "no2": (NO2_RAMP, NO2_ALPHAS)}

NOTES = {
    "pm25": "Surface PM2.5 concentration.",
    "no2": "Model level 137 NO2 mass mixing ratio times dry-air density from surface pressure and "
           "2 m temperature. Approximate.",
}

Frame = tuple[grib.Field, np.ndarray]  # a decoded field and its values in µg/m³


class Retriever(Protocol):
    def retrieve(self, dataset: str, request: dict) -> bytes: ...


def latest_run(now: datetime) -> datetime:
    """Newest run the ADS guarantees to have published by `now`."""
    now = now.astimezone(timezone.utc)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if now.hour >= 22:
        return day + timedelta(hours=12)
    if now.hour >= 10:
        return day
    return day - timedelta(hours=12)


def build_request(run: datetime, variables: list[str] = PM25_VARIABLES, model_level: str | None = None) -> dict:
    d = run.strftime("%Y-%m-%d")
    request = {
        "variable": list(variables),
        "date": [f"{d}/{d}"],
        "time": [run.strftime("%H:00")],
        "leadtime_hour": [str(h) for h in LEADS],
        "type": ["forecast"],
        "data_format": "grib",
    }
    if model_level is not None:
        request["model_level"] = [model_level]
    return request


def retrieve_fields(client: Retriever, request: dict) -> list[grib.Field]:
    data = client.retrieve(DATASET, request)
    with tempfile.NamedTemporaryFile(suffix=".grib") as tmp:
        tmp.write(data)
        tmp.flush()
        fields = grib.read_fields(tmp.name)
    if not fields:
        raise RuntimeError(f"CAMS {request['variable']} decoded to no fields; refusing to publish an empty layer")
    return fields


def air_density(surface_pressure: np.ndarray, temperature: np.ndarray) -> np.ndarray:
    """Dry-air density in kg/m³ from pressure (Pa) and temperature (K): rho = p / (R_d T)."""
    return surface_pressure / (static.conversion("dry_air_gas_constant") * temperature)


def no2_ugm3(no2: list[grib.Field], met: list[grib.Field]) -> list[Frame]:
    """Model level NO2 (kg/kg) to µg/m³, pairing each step with its surface pressure and 2 m temperature."""
    by_step: dict[tuple[datetime, int], dict[str, grib.Field]] = {}
    for f in met:
        by_step.setdefault((f.run, f.step_h), {})[f.short_name] = f
    to_ug = static.conversion("kg_per_m3_to_ugm3")
    frames: list[Frame] = []
    for f in no2:
        step = by_step.get((f.run, f.step_h), {})
        sp, t2m = step.get("sp"), step.get("2t")
        if sp is None or t2m is None:
            log.warning("no surface pressure or 2 m temperature for NO2 at +%dh; skipping it", f.step_h)
            continue
        if not (sp.grid.values.shape == t2m.grid.values.shape == f.grid.values.shape):
            raise RuntimeError("NO2 and surface fields are on different grids")
        rho = air_density(sp.grid.values, t2m.grid.values)
        # Surface air is roughly 1 kg/m³; anything far off means pressure or temperature came in other units.
        median = float(np.nanmedian(rho))
        if not 0.5 < median < 2:
            raise RuntimeError(f"implausible air density {median:.3g} kg/m³; check surface pressure (Pa) and temperature (K) units")
        frames.append((f, f.grid.values * rho * to_ug))
    if not frames:
        raise RuntimeError("no NO2 step had matching surface fields; refusing to publish an empty layer")
    return frames


def fetch_pm25(client: Retriever, run: datetime) -> list[Frame]:
    to_ug = static.conversion("kg_per_m3_to_ugm3")
    return [(f, f.grid.values * to_ug) for f in retrieve_fields(client, build_request(run, PM25_VARIABLES))]


def fetch_no2(client: Retriever, run: datetime) -> list[Frame]:
    no2 = retrieve_fields(client, build_request(run, NO2_VARIABLES, NO2_MODEL_LEVEL))
    met = retrieve_fields(client, build_request(run, MET_VARIABLES))
    return no2_ugm3(no2, met)


FETCH: dict[str, Callable[[Retriever, datetime], list[Frame]]] = {"pm25": fetch_pm25, "no2": fetch_no2}


def render(grid: raster.Grid, parameter: str) -> bytes:
    """Colour a µg/m³ grid by WHO 24-hour band and encode it as a Mercator PNG."""
    ramp, alphas = STYLE[parameter]
    merc = raster.resample_to_mercator(grid, IMAGE_SIZE, IMAGE_SIZE)
    return png.encode_rgba(raster.colorize(merc, static.who_edges(parameter), ramp, alphas))


def update(out: Path, now: datetime, client: Retriever | None, parameter: str = "pm25") -> dict:
    """Add the newest run's frames if needed, prune the past beyond 72 hours, write the manifest."""
    base = f"model/{parameter}"
    manifest_path = out / base / "manifest.json"
    manifest = read_json(manifest_path, {"frames": []})
    frames = {f["valid"]: f for f in manifest.get("frames", []) if (out / f["file"]).exists()}
    run = latest_run(now)
    have = max((parse_iso(f["run"]) for f in frames.values()), default=None)

    if have is not None and have >= run:
        log.info("%s model frames already include run %s", parameter, iso(run))
    elif client is None:
        log.warning("ADS_API_KEY is not set; keeping %d existing %s model frames", len(frames), parameter)
    else:
        rendered = 0
        for f, ugm3 in FETCH[parameter](client, run):
            if not np.isfinite(ugm3).any():
                log.warning("skipping empty %s field at +%dh", parameter, f.step_h)
                continue
            grid = raster.Grid(ugm3, f.grid.lat0, f.grid.dlat, f.grid.lon0, f.grid.dlon)
            rel = f"{base}/{stamp(f.valid)}.png"
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_bytes(render(grid, parameter))
            frames[iso(f.valid)] = {"valid": iso(f.valid), "run": iso(f.run), "lead": f.step_h, "file": rel}
            rendered += 1
        log.info("rendered %d CAMS %s frames from run %s", rendered, parameter, iso(run))

    cutoff = hour_floor(now) - KEEP_PAST
    kept = []
    for valid, f in sorted(frames.items()):
        if parse_iso(valid) < cutoff:
            (out / f["file"]).unlink(missing_ok=True)
        else:
            kept.append(f)
    manifest = {
        "parameter": parameter,
        "units": "µg/m³",
        "source": "CAMS global atmospheric composition forecasts",
        "note": NOTES[parameter],
        "bounds": raster.BOUNDS,
        "latest_run": max((f["run"] for f in kept), default=None),
        "frames": kept,
    }
    write_json(manifest_path, manifest)
    return manifest


class SharedDeadline:
    """One time budget for every ADS request in a run, so the workflow step cannot overrun."""

    def __init__(self, client: ads.ADSClient, seconds: float, clock: Callable[[], float] = time.monotonic):
        self.client, self.clock = client, clock
        self.end = clock() + seconds

    def retrieve(self, dataset: str, request: dict) -> bytes:
        left = self.end - self.clock()
        if left <= 0:
            raise ads.ADSError("ADS time budget used up; keeping previous frames")
        self.client.timeout_s = left
        return self.client.retrieve(dataset, request)


def update_all(out: Path, now: datetime, client: Retriever | None) -> list[str]:
    """Update every layer independently; return the parameters that failed."""
    failed = []
    for parameter in PARAMETERS:
        try:
            update(out, now, client, parameter)
        except (ads.ADSError, ads.net.FetchError, RuntimeError) as err:
            log.error("CAMS %s update failed, previous frames kept: %s", parameter, err)
            failed.append(parameter)
    return failed


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--timeout-min", type=float, default=20, help="total ADS wait across all requests")
    args = ap.parse_args(argv)
    key = os.environ.get("ADS_API_KEY", "").strip()
    client = SharedDeadline(ads.ADSClient(key=key), args.timeout_min * 60) if key else None
    return 1 if update_all(args.out, datetime.now(timezone.utc), client) else 0


if __name__ == "__main__":
    sys.exit(main())
