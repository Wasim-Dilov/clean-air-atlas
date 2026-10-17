"""Build the station layers: python -m pipeline.build_stations --out web/public/data

Needs OPENAQ_API_KEY in the environment. For each pollutant it writes the latest frame,
a station index, run stats and the rolling 72-hour history. Fails loudly (non-zero
exit) rather than writing an empty or near-empty layer.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import history, openaq

log = logging.getLogger("build_stations")

MIN_STATIONS = {"pm25": 200, "no2": 100}


def write_json(path: Path, payload: object) -> None:
    history.write_json(path, payload)


def run(out: Path, key: str, parameter: str, min_stations: int, now: datetime | None = None,
        keep_history: bool = False, **kw) -> dict:
    now = now or datetime.now(timezone.utc)
    ids = openaq.resolve(key, parameter, **kw)
    locations = openaq.fetch_locations(key, ids, **kw)
    latest = openaq.fetch_latest(key, ids, now, **kw)
    frame, index, stats = openaq.build_frame(parameter, latest, locations, now)
    log.info("%s: %s", parameter, json.dumps(stats.as_dict()))
    if stats.kept < min_stations:
        raise SystemExit(
            f"Only {stats.kept} {parameter} stations passed checks (minimum {min_stations}). "
            "Refusing to publish a near-empty layer."
        )
    write_json(out / f"stations-{parameter}.json", frame)
    write_json(out / f"stations-{parameter}-index.json", index)
    write_json(out / f"stations-{parameter}-stats.json", {"generated": frame["generated"], **stats.as_dict()})
    if keep_history:
        history.add_station_frame(out, parameter, frame, now)
    return stats.as_dict()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--parameter", action="append", choices=sorted(openaq.PARAMETERS),
                    help="repeatable; default pm25 and no2")
    ap.add_argument("--min-stations", type=int, default=None)
    ap.add_argument("--history", action="store_true", help="also update the 72-hour history")
    args = ap.parse_args(argv)

    key = os.environ.get("OPENAQ_API_KEY", "").strip()
    if not key:
        log.error("OPENAQ_API_KEY is not set (add it as a repository secret)")
        return 2
    failed = []
    for parameter in args.parameter or ["pm25", "no2"]:
        minimum = args.min_stations if args.min_stations is not None else MIN_STATIONS[parameter]
        try:
            run(args.out, key, parameter, minimum, keep_history=args.history)
        except (openaq.net.FetchError, SystemExit) as err:
            log.error("%s failed: %s", parameter, err)
            failed.append(parameter)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
