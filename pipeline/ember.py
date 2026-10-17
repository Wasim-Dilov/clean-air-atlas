"""Trim Ember's yearly electricity data into data/static/ember_electricity.json.

Run by hand when Ember publishes a new release (yearly data; see CLAUDE.md):

    python -m pipeline.ember --csv path/to/release_generation_yearly_global.csv

Without --csv it downloads the CSV from Ember (about 16 MB, CC BY 4.0).
"""

from __future__ import annotations

import argparse
import csv
import io
import logging
import sys
from datetime import date
from pathlib import Path

from . import net
from .history import write_json

log = logging.getLogger("ember")

URL = "https://files.ember-energy.org/public-downloads/generation/outputs/release_generation_yearly_global.csv"
OUT = Path(__file__).resolve().parent.parent / "data" / "static" / "ember_electricity.json"

# Ember's non-aggregated generation sources, in a fixed order (fossil first).
FUELS = ["Coal", "Gas", "Other fossil", "Nuclear", "Hydro", "Wind", "Solar", "Bioenergy", "Other renewables"]
FOSSIL = {"Coal", "Gas", "Other fossil"}
FIRST_YEAR = 2016


def _num(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def trim(rows: list[dict]) -> dict:
    countries: dict[str, dict] = {}
    for r in rows:
        iso3 = (r.get("ISO 3 code") or "").strip()
        if r.get("Area type") != "Country or economy" or not iso3:
            continue
        year = int(r["Year"])
        if year < FIRST_YEAR:
            continue
        c = countries.setdefault(iso3, {"name": r["Area"], "years": {}})
        # Ember omits a source's row when a country has none of it, so absent rows count as zero.
        y = c["years"].setdefault(str(year), {"twh": [0.0] * len(FUELS), "total_twh": None, "intensity": None})
        src = r["Electricity source"]
        if src in FUELS:
            y["twh"][FUELS.index(src)] = _num(r["Generation (TWh)"]) or 0.0
        elif src == "Total generation":
            y["total_twh"] = _num(r["Generation (TWh)"])
            y["intensity"] = _num(r["Emissions intensity (gCO2e/kWh)"])

    # Keep only years whose sources add up to the reported total.
    years: set[int] = set()
    for c in countries.values():
        for k in list(c["years"]):
            y = c["years"][k]
            total = y["total_twh"]
            if total is None or abs(sum(y["twh"]) - total) > max(0.02 * total, 0.05):
                del c["years"][k]
        years.update(int(k) for k in c["years"])
    countries = {k: v for k, v in sorted(countries.items()) if v["years"]}
    return {
        "source": "Ember, Yearly Electricity Data (release_generation_yearly_global.csv)",
        "url": "https://ember-energy.org/data/yearly-electricity-data/",
        "download_url": URL,
        "licence": "CC BY 4.0",
        "credit": "Ember (2026), Yearly Electricity Data, CC BY 4.0",
        "retrieved": date.today().isoformat(),
        "units": {"twh": "TWh", "intensity": "gCO2e/kWh (Ember emissions intensity of total generation)"},
        "fuels": FUELS,
        "fossil": sorted(FOSSIL),
        "years": sorted(years),
        "countries": countries,
    }


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    text = args.csv.read_text(encoding="utf-8") if args.csv else net.get_bytes(URL).decode("utf-8")
    data = trim(list(csv.DictReader(io.StringIO(text))))
    if len(data["countries"]) < 150:
        log.error("only %d countries parsed; refusing to overwrite", len(data["countries"]))
        return 1
    write_json(args.out, data)
    log.info("wrote %d countries, years %s-%s", len(data["countries"]), data["years"][0], data["years"][-1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
