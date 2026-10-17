"""CAMS global forecast of surface PM2.5, as coloured Mercator images for the time slider.

    ADS_API_KEY=... python -m pipeline.cams --out web/public/data

Runs every hour but only calls the ADS when a newer model run should be out
(00 UTC run by 10:00 UTC, 12 UTC run by 22:00 UTC). Without a key, or if the ADS
times out, the frames already pulled from the live site are kept.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import ads, grib, png, raster, static
from .history import hour_floor, iso, parse_iso, read_json, stamp, write_json

log = logging.getLogger("cams")

DATASET = "cams-global-atmospheric-composition-forecasts"
LEADS = list(range(0, 121, 3))  # 3-hourly to 5 days
KEEP_PAST = timedelta(hours=72)
IMAGE_SIZE = 512

# Must match PM25_RAMP in web/src/bands.ts (a test checks this).
PM25_RAMP = ["#a83902", "#d24903", "#f5642b", "#ff936d", "#ffc0ab", "#fee5dc"]
# The band that meets the WHO guideline stays clear, so the haze shows only exceedance.
ALPHAS = [0, 95, 125, 150, 175, 195]


def latest_run(now: datetime) -> datetime:
    """Newest run the ADS guarantees to have published by `now`."""
    now = now.astimezone(timezone.utc)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if now.hour >= 22:
        return day + timedelta(hours=12)
    if now.hour >= 10:
        return day
    return day - timedelta(hours=12)


def build_request(run: datetime) -> dict:
    d = run.strftime("%Y-%m-%d")
    return {
        "variable": ["particulate_matter_2.5um"],
        "date": [f"{d}/{d}"],
        "time": [run.strftime("%H:00")],
        "leadtime_hour": [str(h) for h in LEADS],
        "type": ["forecast"],
        "data_format": "grib",
    }


def render(field: grib.Field, edges: list[float]) -> bytes:
    ugm3 = field.grid.values * static.conversion("kg_per_m3_to_ugm3")
    grid = raster.Grid(ugm3, field.grid.lat0, field.grid.dlat, field.grid.lon0, field.grid.dlon)
    merc = raster.resample_to_mercator(grid, IMAGE_SIZE, IMAGE_SIZE)
    return png.encode_rgba(raster.colorize(merc, edges, PM25_RAMP, ALPHAS))


def update(out: Path, now: datetime, client: ads.ADSClient | None) -> dict:
    """Add the newest run's frames if needed, prune the past beyond 72 hours, write the manifest."""
    base = "model/pm25"
    manifest_path = out / base / "manifest.json"
    manifest = read_json(manifest_path, {"frames": []})
    frames = {f["valid"]: f for f in manifest.get("frames", []) if (out / f["file"]).exists()}
    run = latest_run(now)
    have = max((parse_iso(f["run"]) for f in frames.values()), default=None)

    if have is not None and have >= run:
        log.info("model frames already include run %s", iso(run))
    elif client is None:
        log.warning("ADS_API_KEY is not set; keeping %d existing model frames", len(frames))
    else:
        data = client.retrieve(DATASET, build_request(run))
        with tempfile.NamedTemporaryFile(suffix=".grib") as tmp:
            tmp.write(data)
            tmp.flush()
            fields = grib.read_fields(tmp.name)
        if not fields:
            raise RuntimeError("CAMS download decoded to no fields; refusing to publish an empty layer")
        edges = static.who_edges("pm25")
        for f in fields:
            if not np.isfinite(f.grid.values).any():
                log.warning("skipping empty field at +%dh", f.step_h)
                continue
            rel = f"{base}/{stamp(f.valid)}.png"
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_bytes(render(f, edges))
            frames[iso(f.valid)] = {"valid": iso(f.valid), "run": iso(f.run), "lead": f.step_h, "file": rel}
        log.info("rendered %d CAMS frames from run %s", len(fields), iso(run))

    cutoff = hour_floor(now) - KEEP_PAST
    kept = []
    for valid, f in sorted(frames.items()):
        if parse_iso(valid) < cutoff:
            (out / f["file"]).unlink(missing_ok=True)
        else:
            kept.append(f)
    manifest = {
        "parameter": "pm25",
        "units": "µg/m³",
        "source": "CAMS global atmospheric composition forecasts",
        "bounds": raster.BOUNDS,
        "latest_run": max((f["run"] for f in kept), default=None),
        "frames": kept,
    }
    write_json(manifest_path, manifest)
    return manifest


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--timeout-min", type=float, default=20)
    args = ap.parse_args(argv)
    key = os.environ.get("ADS_API_KEY", "").strip()
    client = ads.ADSClient(key=key, timeout_s=args.timeout_min * 60) if key else None
    try:
        update(args.out, datetime.now(timezone.utc), client)
    except (ads.ADSError, ads.net.FetchError, RuntimeError) as err:
        log.error("CAMS update failed, previous frames kept: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
