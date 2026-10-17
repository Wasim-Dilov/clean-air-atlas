"""Restore the last good data files from the live site when a fetch fails.

python -m pipeline.fallback --base-url https://<user>.github.io/<repo>/data --out web/public/data \
    --required stations-pm25.json -- stations-pm25.json stations-pm25-index.json

Files already present in --out (written by a successful fetch this run) are left alone.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import net
from .history import write_json

log = logging.getLogger("fallback")


def restore(base_url: str, out: Path, names: list[str], get=net.get_json) -> list[str]:
    """Restore each missing file; return the names that could not be restored."""
    missing = []
    for name in names:
        if (out / name).exists():
            continue
        try:
            payload = get(net.build_url(base_url, name))
        except net.FetchError as err:
            log.error("could not restore %s: %s", name, err)
            missing.append(name)
            continue
        if isinstance(payload, dict) and "count" in payload and not payload["count"]:
            raise SystemExit(f"Live copy of {name} is empty; nothing safe to restore")
        write_json(out / name, payload)
        log.info("restored %s from live site", name)
    return missing


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--required", nargs="*", default=[], help="names whose absence fails the run")
    ap.add_argument("names", nargs="+")
    args = ap.parse_args(argv)
    missing = restore(args.base_url, args.out, args.names)
    hard = [m for m in missing if m in args.required]
    if hard:
        log.error("no last good copy of %s; refusing to deploy without it", hard)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
