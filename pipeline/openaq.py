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

from . import net

log = logging.getLogger(__name__)

API_BASE = "https://api.openaq.org/v3"
PAGE_LIMIT = 1000  # documented maximum page size
REQUEST_GAP_S = 1.1  # free keys allow 60 requests a minute

# OpenAQ parameter ids (https://docs.openaq.org/resources/parameters)
PARAMETERS = {
    "pm25": {"id": 2, "units": "µg/m³"},
}

# Plausibility window for an hourly station value, in the parameter's units.
# A data-quality filter for broken sensors, not a sourced statistic.
PLAUSIBLE = {
    "pm25": (0.0, 1000.0),
}

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


def fetch_locations(key: str, parameter: str, **kw: Any) -> dict[int, dict]:
    """Location metadata keyed by location id."""
    pid = PARAMETERS[parameter]["id"]
    out: dict[int, dict] = {}
    for loc in paginate("/locations", {"parameters_id": pid}, key, **kw):
        out[int(loc["id"])] = loc
    log.info("locations with %s: %d", parameter, len(out))
    return out


def fetch_latest(key: str, parameter: str, now: datetime, **kw: Any) -> list[dict]:
    pid = PARAMETERS[parameter]["id"]
    since = (now - MAX_AGE).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = list(paginate(f"/parameters/{pid}/latest", {"datetime_min": since}, key, **kw))
    log.info("latest %s readings since %s: %d", parameter, since, len(rows))
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
