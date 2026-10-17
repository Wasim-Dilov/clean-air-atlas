"""Precompute solar output profiles from PVGIS (EU JRC) into data/static/pv_profiles.json.

Run by hand (PVGIS data changes rarely):

    python -m pipeline.pvgis

- Preset sites get a full hourly year (8760 values).
- Every country in the Ember data gets a typical day per month (12 x 24 values), from a
  single point inside the country (centroid of its largest polygon in Natural Earth
  1:110m). That is a rough national profile, labelled as such in the app.

Values are average PV output in watts per kilowatt-peak installed, for a fixed
free-standing c-Si system at PVGIS's optimal tilt and azimuth with 14 % system loss
(PVGIS default), for the year 2023 (the latest year PVGIS serves).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from . import net
from .history import write_json

log = logging.getLogger("pvgis")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "static" / "pv_profiles.json"
TOPO = ROOT / "web" / "node_modules" / "world-atlas" / "countries-110m.json"
API = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc"
YEAR = 2023
PARAMS = {"pvcalculation": 1, "peakpower": 1, "loss": 14, "optimalangles": 1,
          "startyear": YEAR, "endyear": YEAR, "outputformat": "json"}

# Preset sites: coordinates and the local time zone used to align the profile.
SITES = {
    # Ikeja, Lagos: on land (a point on the lagoon returned elevation 0). Nigeria uses WAT, UTC+1, no DST.
    "lagos": {"name": "Lagos (Ikeja), Nigeria", "lat": 6.60, "lon": 3.35, "utc_offset_h": 1},
}


# ------------------------------------------------------------- TopoJSON (Natural Earth via world-atlas)

def decode_topology(topo: dict) -> dict[str, list[list[tuple[float, float]]]]:
    """Return {numeric id: [rings]} with rings as lon/lat lists (outer rings and holes together)."""
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(indexes: list[int]) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for i in indexes:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts if not out else pts[1:])
        return out

    shapes: dict[str, list[list[tuple[float, float]]]] = {}
    for geom in topo["objects"]["countries"]["geometries"]:
        gid = geom.get("id")
        if gid is None:
            continue
        polys = geom["arcs"] if geom["type"] == "MultiPolygon" else [geom["arcs"]] if geom["type"] == "Polygon" else []
        shapes[str(gid)] = [ring(r) for poly in polys for r in poly[:1]]  # outer rings only
    return shapes


def ring_centroid(ring: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Planar centroid (lon, lat) and absolute area of a ring in degree units."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-12:
        xs, ys = zip(*ring)
        return sum(xs) / len(xs), sum(ys) / len(ys), 0.0
    return cx / (3 * a), cy / (3 * a), abs(a) / 2


def representative_point(rings: list[list[tuple[float, float]]]) -> tuple[float, float]:
    lon, lat, _ = max((ring_centroid(r) for r in rings), key=lambda c: c[2])
    return round(lat, 2), round(lon, 2)


# ------------------------------------------------------------- PVGIS

def _get(url: str):
    return net.get_json(url, max_retries=1)


def fetch_hourly(lat: float, lon: float, get=_get) -> tuple[list[tuple[datetime, float]], str]:
    """Hourly output for YEAR, plus a short description of the database and mounting used.

    PVGIS sometimes fails on optimalangles=1 at a location; the fallback then uses its
    default mounting (horizontal), which gives somewhat lower output.
    """
    last: Exception | None = None
    plain = {k: v for k, v in PARAMS.items() if k != "optimalangles"}
    for params, mounting in ((PARAMS, "optimal"), (plain, "horizontal (PVGIS default)")):
        try:
            data = get(f"{API}?{urlencode({'lat': lat, 'lon': lon, **params})}")
        except net.FetchError as err:
            last = err
            continue
        rows = data["outputs"]["hourly"]
        out = [(datetime.strptime(r["time"], "%Y%m%d:%H%M").replace(tzinfo=timezone.utc), float(r["P"])) for r in rows]
        if len(out) >= 8760:
            db = data.get("inputs", {}).get("meteo_data", {}).get("radiation_db", "")
            return out, f"{db}, {mounting} mounting"
        last = net.FetchError(f"only {len(out)} hourly values for {lat},{lon}")
    raise last or net.FetchError("no data")


def local_hour_index(series: list[tuple[datetime, float]], utc_offset_h: int) -> list[int]:
    """Hourly W/kWp for one calendar year in local time (rotated by the UTC offset)."""
    values = [round(p) for _, p in series[:8760]]
    k = utc_offset_h % 8760
    return values[-k:] + values[:-k] if k else values


def monthly_typical_day(series: list[tuple[datetime, float]], utc_offset_h: int) -> list[list[int]]:
    sums = [[0.0] * 24 for _ in range(12)]
    counts = [[0] * 24 for _ in range(12)]
    for t, p in series:
        local_h = (t.hour + utc_offset_h) % 24
        sums[t.month - 1][local_h] += p
        counts[t.month - 1][local_h] += 1
    return [[round(s / c) if c else 0 for s, c in zip(sm, cn)] for sm, cn in zip(sums, counts)]


def build(get=_get, sleep=time.sleep, countries: list[str] | None = None) -> dict:
    static = ROOT / "data" / "static"
    ember = json.loads((static / "ember_electricity.json").read_text())
    alpha3_to_num = {a3: num for num, a3 in json.loads((static / "iso3166.json").read_text())["numeric_to_alpha3"].items()}
    shapes = decode_topology(json.loads(TOPO.read_text()))

    sites = {}
    for key, site in SITES.items():
        series, db = fetch_hourly(site["lat"], site["lon"], get)
        sites[key] = {**site, "database": db, "hourly_w_per_kwp": local_hour_index(series, site["utc_offset_h"])}
        sleep(0.2)

    out_countries = {}
    missing = []
    for iso3 in countries or sorted(ember["countries"]):
        num = alpha3_to_num.get(iso3)
        rings = shapes.get(num) if num else None
        if not rings:
            missing.append(iso3)
            continue
        lat, lon = representative_point(rings)
        offset = round(lon / 15)
        try:
            series, db = fetch_hourly(lat, lon, get)
        except (net.FetchError, KeyError) as err:
            log.warning("%s at %s,%s: %s", iso3, lat, lon, err)
            missing.append(iso3)
            continue
        out_countries[iso3] = {"lat": lat, "lon": lon, "utc_offset_h": offset, "database": db,
                               "monthly_day_w_per_kwp": monthly_typical_day(series, offset)}
        sleep(0.2)
    log.info("profiles for %d countries; none for %s", len(out_countries), missing)
    return {
        "source": "PVGIS 5.3 seriescalc, European Commission Joint Research Centre",
        "credit": "PVGIS © European Communities, 2001-2026",
        "url": "https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_en",
        "retrieved": datetime.now(timezone.utc).date().isoformat(),
        "year": YEAR,
        "system": "fixed free-standing c-Si, optimal tilt and azimuth, 14 % system loss (PVGIS default), 1 kWp",
        "units": "W per kWp (average over the hour)",
        "time_basis": "PVGIS hourly values are in UTC; sites use their legal UTC offset, countries an approximate solar offset round(lon/15)",
        "country_point": "centroid of the largest polygon in Natural Earth 1:110m (world-atlas 2.0.2); a rough national profile",
        "sites": sites,
        "countries": out_countries,
        "no_profile": missing,
    }


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    data = build()
    if len(data["countries"]) < 100:
        log.error("only %d country profiles; refusing to overwrite", len(data["countries"]))
        return 1
    write_json(args.out, data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
