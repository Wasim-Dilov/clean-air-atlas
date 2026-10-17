"""Build the station layer: python -m pipeline.build_stations --out web/public/data

Needs OPENAQ_API_KEY in the environment. Fails loudly (non-zero exit) rather than
writing an empty or near-empty layer.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import openaq

log = logging.getLogger("build_stations")


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def run(out: Path, key: str, parameter: str, min_stations: int, now: datetime | None = None, **kw) -> dict:
    now = now or datetime.now(timezone.utc)
    locations = openaq.fetch_locations(key, parameter, **kw)
    latest = openaq.fetch_latest(key, parameter, now, **kw)
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
    return stats.as_dict()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--parameter", default="pm25", choices=sorted(openaq.PARAMETERS))
    ap.add_argument("--min-stations", type=int, default=200)
    args = ap.parse_args(argv)

    key = os.environ.get("OPENAQ_API_KEY", "").strip()
    if not key:
        log.error("OPENAQ_API_KEY is not set (add it as a repository secret)")
        return 2
    try:
        run(args.out, key, args.parameter, args.min_stations)
    except openaq.net.FetchError as err:
        log.error("OpenAQ fetch failed: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
