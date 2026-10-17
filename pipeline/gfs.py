"""NOAA GFS 10 m wind for the particle animation.

    python -m pipeline.gfs --out web/public/data

Fetches only the UGRD and VGRD "10 m above ground" messages from the 1-degree GFS file
on NOAA Open Data (AWS, no account) using the .idx byte offsets, then packs U and V
into the red and green channels of a small PNG plus a JSON with the scaling.
"""

from __future__ import annotations

import argparse
import logging
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import numpy as np

from . import grib, net, png
from .history import iso, write_json

log = logging.getLogger("gfs")

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
WANTED = {("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")}
CYCLE_H = 6
STEP_H = 3


def file_url(cycle: datetime, step: int) -> str:
    d, h = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    return f"{BUCKET}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.1p00.f{step:03d}"


def candidates(now: datetime, back: int = 4) -> list[tuple[datetime, int]]:
    """(cycle, forecast step) pairs to try, newest cycle first, step nearest to now."""
    now = now.astimezone(timezone.utc)
    newest = now.replace(minute=0, second=0, microsecond=0, hour=(now.hour // CYCLE_H) * CYCLE_H)
    out = []
    for k in range(back):
        cycle = newest - timedelta(hours=CYCLE_H * k)
        step = int(round((now - cycle).total_seconds() / 3600 / STEP_H)) * STEP_H
        out.append((cycle, max(0, step)))
    return out


def byte_ranges(idx_text: str) -> list[tuple[int, int | None]]:
    """(start, end inclusive or None for end of file) for the wanted messages."""
    rows = [line.split(":") for line in idx_text.splitlines() if line.strip()]
    ranges = []
    for i, r in enumerate(rows):
        if len(r) > 4 and (r[3], r[4]) in WANTED:
            start = int(r[1])
            end = int(rows[i + 1][1]) - 1 if i + 1 < len(rows) else None
            ranges.append((start, end))
    return ranges


def download(cycle: datetime, step: int, get: Callable[..., bytes] = net.get_bytes) -> bytes:
    url = file_url(cycle, step)
    ranges = byte_ranges(get(url + ".idx").decode("utf-8", "replace"))
    if len(ranges) != len(WANTED):
        raise net.FetchError(f"10 m wind not found in {url}.idx")
    data = b""
    for start, end in ranges:
        data += get(url, {"Range": f"bytes={start}-{'' if end is None else end}"})
    return data


def pack(u: np.ndarray, v: np.ndarray) -> tuple[bytes, dict]:
    """Pack U and V (m/s) into an RGBA PNG: R = U, G = V, scaled to 0..255; alpha 0 where missing."""
    lo = float(np.floor(min(np.nanmin(u), np.nanmin(v))))
    hi = float(np.ceil(max(np.nanmax(u), np.nanmax(v))))
    if hi <= lo:
        hi = lo + 1
    scale = lambda a: np.clip(np.round((a - lo) / (hi - lo) * 255), 0, 255)
    img = np.zeros((*u.shape, 4), dtype=np.uint8)
    img[..., 0] = np.nan_to_num(scale(u)).astype(np.uint8)
    img[..., 1] = np.nan_to_num(scale(v)).astype(np.uint8)
    img[..., 3] = np.where(np.isnan(u) | np.isnan(v), 0, 255).astype(np.uint8)
    return png.encode_rgba(img), {"min": lo, "max": hi}


def build(out: Path, now: datetime, get: Callable[..., bytes] = net.get_bytes) -> dict:
    last_err: Exception | None = None
    for cycle, step in candidates(now):
        try:
            data = download(cycle, step, get)
        except net.FetchError as err:
            log.info("GFS %s f%03d not available: %s", iso(cycle), step, err)
            last_err = err
            continue
        with tempfile.NamedTemporaryFile(suffix=".grib2") as tmp:
            tmp.write(data)
            tmp.flush()
            fields = {f.short_name: f for f in grib.read_fields(tmp.name)}
        if "10u" not in fields or "10v" not in fields:
            raise RuntimeError(f"decoded {sorted(fields)} instead of 10u/10v")
        u, v = fields["10u"].grid, fields["10v"].grid
        speed = np.hypot(u.values, v.values)
        if not np.isfinite(speed).any() or np.nanmax(speed) > 150:
            raise RuntimeError("implausible wind field; refusing to publish it")
        image, scaling = pack(u.values, v.values)
        (out / "wind").mkdir(parents=True, exist_ok=True)
        (out / "wind" / "wind.png").write_bytes(image)
        meta = {
            "source": "NOAA NCEP GFS 1.0 degree, 10 m above ground",
            "cycle": iso(cycle), "step_h": step, "valid": iso(fields["10u"].valid),
            "width": u.values.shape[1], "height": u.values.shape[0],
            "lat0": u.lat0, "dlat": u.dlat, "lon0": u.lon0, "dlon": u.dlon,
            "u": scaling, "v": scaling, "units": "m/s",
            "max_speed": round(float(np.nanmax(speed)), 1),
        }
        write_json(out / "wind" / "wind.json", meta)
        log.info("wind from GFS %s +%dh, max %.1f m/s", iso(cycle), step, meta["max_speed"])
        return meta
    raise net.FetchError(f"no recent GFS cycle available ({last_err})")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    try:
        build(args.out, datetime.now(timezone.utc))
    except (net.FetchError, RuntimeError) as err:
        log.error("wind update failed: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
