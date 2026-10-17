"""Rolling 72-hour history, kept on the live site instead of in git.

Each run pulls the previous frames from the deployed site, adds the new hour, prunes
anything older than 72 hours and writes everything back into the Pages artifact.

    python -m pipeline.history pull --base-url https://<user>.github.io/<repo>/data --out web/public/data
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from . import net

log = logging.getLogger("history")

KEEP = timedelta(hours=72)
SHARDS = 16
PARAMETERS = ("pm25", "no2")


def hour_floor(t: datetime) -> datetime:
    return t.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def stamp(t: datetime) -> str:
    return t.strftime("%Y%m%dT%H")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


# ---------------------------------------------------------------- stations

def station_manifest_path(out: Path, parameter: str) -> Path:
    return out / "stations" / parameter / "manifest.json"


def add_station_frame(out: Path, parameter: str, frame: dict, now: datetime) -> dict:
    """Store this hour's frame, prune old hours, rebuild coordinates and per-station series."""
    t = hour_floor(now)
    base = f"stations/{parameter}"
    rel = f"{base}/{stamp(t)}.json"
    write_json(out / rel, {"t": iso(t), "id": frame["id"], "v": frame["value"]})

    manifest = read_json(station_manifest_path(out, parameter), {"frames": []})
    frames = [f for f in manifest.get("frames", []) if f["t"] != iso(t)]
    frames.append({"t": iso(t), "file": rel, "count": frame["count"]})
    keep, drop = [], []
    for f in sorted(frames, key=lambda f: f["t"]):
        (keep if parse_iso(f["t"]) > t - KEEP else drop).append(f)
    for f in drop:
        (out / f["file"]).unlink(missing_ok=True)

    # Coordinates: union over kept frames, newest position wins.
    old = read_json(out / base / "coords.json", {"id": [], "lon": [], "lat": []})
    coords = {i: (lo, la) for i, lo, la in zip(old["id"], old["lon"], old["lat"])}
    coords.update({i: (lo, la) for i, lo, la in zip(frame["id"], frame["lon"], frame["lat"])})

    by_hour: dict[str, dict[int, float]] = {}
    needed: set[int] = set()
    for f in keep:
        data = read_json(out / f["file"])
        if data is None:
            log.warning("missing history frame %s", f["file"])
            continue
        by_hour[f["t"]] = dict(zip(data["id"], data["v"]))
        needed.update(data["id"])
    keep = [f for f in keep if f["t"] in by_hour]
    ids = sorted(i for i in needed if i in coords)
    write_json(out / base / "coords.json", {
        "id": ids, "lon": [coords[i][0] for i in ids], "lat": [coords[i][1] for i in ids],
    })

    hours = [iso(t - timedelta(hours=h)) for h in range(71, -1, -1)]
    shards: list[dict[str, list]] = [{} for _ in range(SHARDS)]
    for sid in frame["id"]:
        shards[sid % SHARDS][str(sid)] = [by_hour.get(h, {}).get(sid) for h in hours]
    for k, series in enumerate(shards):
        write_json(out / base / "series" / f"{k}.json", {"hours": hours, "series": series})

    manifest = {
        "parameter": parameter,
        "units": frame["units"],
        "latest": iso(t),
        "coords": f"{base}/coords.json",
        "series": f"{base}/series/{{shard}}.json",
        "shards": SHARDS,
        "frames": keep,
    }
    write_json(station_manifest_path(out, parameter), manifest)
    log.info("%s history: %d hourly frames, %d stations with coordinates", parameter, len(keep), len(ids))
    return manifest


# ---------------------------------------------------------------- pulling from the live site

def pull(base_url: str, out: Path, parameters: tuple[str, ...] = PARAMETERS,
         get_json: Callable[..., Any] = net.get_json, get_bytes: Callable[..., bytes] = net.get_bytes) -> dict[str, int]:
    """Copy the previous frames from the deployed site. Missing pieces are logged, not fatal."""
    counts: dict[str, int] = {}
    for parameter in parameters:
        rel = f"stations/{parameter}/manifest.json"
        counts[f"stations/{parameter}"] = _pull_set(base_url, out, rel, "frames", "file", get_json, json_files=True,
                                                    extra=[f"stations/{parameter}/coords.json"])
        rel = f"model/{parameter}/manifest.json"
        counts[f"model/{parameter}"] = _pull_set(base_url, out, rel, "frames", "file", get_bytes, json_files=False,
                                                 manifest_getter=get_json)
    # Current wind frame: kept if this run's GFS fetch fails.
    for rel, getter, is_json in (("wind/wind.json", get_json, True), ("wind/wind.png", get_bytes, False)):
        try:
            payload = getter(net.build_url(base_url, rel))
        except net.FetchError:
            counts[rel] = 0
            continue
        if is_json:
            write_json(out / rel, payload)
        else:
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_bytes(payload)
        counts[rel] = 1
    return counts


def _pull_set(base_url: str, out: Path, manifest_rel: str, list_key: str, file_key: str,
              getter: Callable[..., Any], json_files: bool, extra: list[str] | None = None,
              manifest_getter: Callable[..., Any] | None = None) -> int:
    try:
        manifest = (manifest_getter or getter)(net.build_url(base_url, manifest_rel))
    except net.FetchError:
        log.info("nothing to pull for %s", manifest_rel)
        return 0
    got = 0
    for entry in manifest.get(list_key, []):
        rel = entry[file_key]
        try:
            payload = getter(net.build_url(base_url, rel))
        except net.FetchError as err:
            log.warning("could not pull %s: %s", rel, err)
            continue
        if json_files:
            write_json(out / rel, payload)
        else:
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_bytes(payload)
        got += 1
    for rel in extra or []:
        try:
            write_json(out / rel, getter(net.build_url(base_url, rel)))
        except net.FetchError:
            pass
    write_json(out / manifest_rel, manifest)
    log.info("pulled %d files for %s", got, manifest_rel)
    return got


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pull")
    p.add_argument("--base-url", required=True)
    p.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    if args.cmd == "pull":
        log.info("pulled: %s", pull(args.base_url, args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
