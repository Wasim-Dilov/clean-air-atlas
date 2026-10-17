"""OpenAQ v3: fetch the latest station values and turn them into a compact map frame.

Docs: https://docs.openaq.org (latest: /v3/parameters/{id}/latest, metadata: /v3/locations).
Called only from the pipeline, never from the browser.
"""

from __future__ import annotations

import logging
import math
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Iterator

from . import net, static

log = logging.getLogger(__name__)

API_BASE = "https://api.openaq.org/v3"
PAGE_LIMIT = 1000  # documented maximum page size
REQUEST_GAP_S = 1.1  # free keys allow 60 requests a minute

# OpenAQ parameters (https://docs.openaq.org/resources/parameters). pm25 is id 2 in µg/m³.
# NO2 ids are looked up by name at run time, because OpenAQ reports NO2 in ppm under
# one id and possibly µg/m³ under another; every value is converted to µg/m³.
PARAMETERS = {
    "pm25": {"name": "pm25", "units": "µg/m³", "ids": [(2, "µg/m³")]},
    "no2": {"name": "no2", "units": "µg/m³", "ids": None},
}

# Plausibility window for an hourly station value, in µg/m³.
# A data-quality filter for broken sensors, not a sourced statistic.
PLAUSIBLE = {
    "pm25": (0.0, 1000.0),
    "no2": (0.0, 2000.0),
}

_UGM3 = {"µg/m³", "μg/m³", "ug/m3", "µg/m3", "μg/m3"}


def unit_factor(parameter: str, units: str) -> float | None:
    """Multiplier from the reported units to µg/m³, or None if unsupported."""
    u = (units or "").strip().lower()
    if u in {x.lower() for x in _UGM3}:
        return 1.0
    if parameter == "no2" and u == "ppm":
        return static.conversion("no2_ppm_to_ugm3")
    if parameter == "no2" and u == "ppb":
        return static.conversion("no2_ppb_to_ugm3")
    return None


def resolve(key: str, parameter: str, **kw: Any) -> list[tuple[int, float]]:
    """(parameter id, factor to µg/m³) pairs to fetch for a pollutant."""
    spec = PARAMETERS[parameter]
    pairs = spec["ids"]
    if pairs is None:
        pairs = [(int(p["id"]), p.get("units", "")) for p in paginate("/parameters", {}, key, **kw)
                 if p.get("name") == spec["name"]]
    out = []
    for pid, units in pairs:
        factor = unit_factor(parameter, units)
        if factor is None:
            log.warning("skipping %s parameter %s in unsupported units %r", parameter, pid, units)
            continue
        out.append((pid, factor))
    if not out:
        raise net.FetchError(f"no usable OpenAQ parameter ids for {parameter}")
    log.info("%s parameter ids: %s", parameter, out)
    return out

MAX_AGE = timedelta(hours=6)  # older readings are not "now"
MAX_FUTURE = timedelta(hours=1)  # tolerate small clock skew only


@dataclass
class FrameStats:
    received: int = 0
    kept: int = 0
    dropped: Counter = field(default_factory=Counter)

    def as_dict(self) -> dict[str, Any]:
        return {"received": self.received, "kept": self.kept, "dropped": dict(self.dropped)}


Getter = Callable[[str, dict[str, str]], Any]


def paginate(path: str, params: dict[str, Any], key: str, *, get: Getter | None = None,
             sleep: Callable[[float], None] = time.sleep, max_pages: int = 500) -> Iterator[dict]:
    """Yield results across pages until a short or empty page."""
    get = get or (lambda url, headers: net.get_json(url, headers))
    for page in range(1, max_pages + 1):
        url = net.build_url(API_BASE, path, {**params, "limit": PAGE_LIMIT, "page": page})
        data = get(url, {"X-API-Key": key})
        results = data.get("results") or []
        yield from results
        if len(results) < PAGE_LIMIT:
            return
        sleep(REQUEST_GAP_S)
    log.warning("stopped after %s pages of %s", max_pages, path)


def fetch_locations(key: str, ids: list[tuple[int, float]], **kw: Any) -> dict[int, dict]:
    """Location metadata keyed by location id."""
    out: dict[int, dict] = {}
    pids = ",".join(str(pid) for pid, _ in ids)
    for loc in paginate("/locations", {"parameters_id": pids}, key, **kw):
        out[int(loc["id"])] = loc
    log.info("locations with parameters %s: %d", pids, len(out))
    return out


def fetch_latest(key: str, ids: list[tuple[int, float]], now: datetime, **kw: Any) -> list[dict]:
    """Latest readings for every id, with values converted to µg/m³."""
    since = (now - MAX_AGE).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows: list[dict] = []
    for pid, factor in ids:
        for row in paginate(f"/parameters/{pid}/latest", {"datetime_min": since}, key, **kw):
            value = row.get("value")
            if isinstance(value, (int, float)) and factor != 1.0:
                row = {**row, "value": value * factor}
            rows.append(row)
    log.info("latest readings since %s for ids %s: %d", since, [p for p, _ in ids], len(rows))
    return rows


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def build_frame(parameter: str, latest: Iterable[dict], locations: dict[int, dict],
                now: datetime) -> tuple[dict, dict, FrameStats]:
    """Clean and join readings with metadata.

    Returns (frame, station_index, stats). The frame is columnar to keep the file small;
    the index maps location id to name, place and provider and is loaded on demand.
    """
    lo, hi = PLAUSIBLE[parameter]
    stats = FrameStats()
    best: dict[int, tuple[datetime, float, float, float]] = {}

    for row in latest:
        stats.received += 1
        loc_id = row.get("locationsId")
        value = row.get("value")
        coords = row.get("coordinates") or {}
        lat, lon = coords.get("latitude"), coords.get("longitude")
        when = _parse_time((row.get("datetime") or {}).get("utc"))

        if loc_id is None or value is None or lat is None or lon is None or when is None:
            stats.dropped["missing_field"] += 1
            continue
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            stats.dropped["not_a_number"] += 1
            continue
        if not (lo <= value <= hi):
            stats.dropped["implausible_value"] += 1
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            stats.dropped["bad_coordinates"] += 1
            continue
        if when < now - MAX_AGE:
            stats.dropped["too_old"] += 1
            continue
        if when > now + MAX_FUTURE:
            stats.dropped["in_future"] += 1
            continue
        meta = locations.get(int(loc_id))
        if meta is not None and meta.get("isMobile"):
            stats.dropped["mobile_sensor"] += 1
            continue
        loc_id = int(loc_id)
        prev = best.get(loc_id)
        if prev is not None:
            stats.dropped["duplicate_sensor"] += 1
            if prev[0] >= when:
                continue
        best[loc_id] = (when, float(value), float(lat), float(lon))

    ids = sorted(best)
    stats.kept = len(ids)
    frame = {
        "parameter": parameter,
        "units": PARAMETERS[parameter]["units"],
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "OpenAQ",
        "count": len(ids),
        "id": ids,
        "lon": [round(best[i][3], 4) for i in ids],
        "lat": [round(best[i][2], 4) for i in ids],
        "value": [round(best[i][1], 1) for i in ids],
        "age_min": [max(0, int((now - best[i][0]).total_seconds() // 60)) for i in ids],
    }

    index: dict[str, list] = {}
    providers: Counter = Counter()
    attributions: dict[str, str | None] = {}
    for i in ids:
        meta = locations.get(i) or {}
        country = (meta.get("country") or {}).get("code") or ""
        provider = (meta.get("provider") or {}).get("name") or ""
        index[str(i)] = [meta.get("name") or "", meta.get("locality") or "", country, provider]
        if provider:
            providers[provider] += 1
        for lic in meta.get("licenses") or []:
            att = lic.get("attribution") or {}
            if att.get("name"):
                attributions.setdefault(att["name"], att.get("url"))

    station_index = {
        "generated": frame["generated"],
        "fields": ["name", "locality", "country", "provider"],
        "stations": index,
        "providers": [{"name": n, "stations": c} for n, c in providers.most_common()],
        "attributions": [{"name": n, "url": u} for n, u in sorted(attributions.items())],
    }
    return frame, station_index, stats
