"""Restore the last good data frame from the live site when a fetch fails.

python -m pipeline.fallback --base-url https://<user>.github.io/<repo>/data --out web/public/data \
    stations-pm25.json stations-pm25-index.json
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import net
from .build_stations import write_json

log = logging.getLogger("fallback")


def restore(base_url: str, out: Path, names: list[str], get=net.get_json) -> None:
    for name in names:
        payload = get(net.build_url(base_url, name))
        if isinstance(payload, dict) and "count" in payload and not payload["count"]:
            raise SystemExit(f"Live copy of {name} is empty; nothing safe to restore")
        write_json(out / name, payload)
        log.info("restored %s from live site", name)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("names", nargs="+")
    args = ap.parse_args(argv)
    try:
        restore(args.base_url, args.out, args.names)
    except net.FetchError as err:
        log.error("could not restore last good frame: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
