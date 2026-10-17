import io
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError

import pytest

from pipeline import build_stations, fallback, net, openaq

NOW = datetime(2026, 10, 17, 14, 0, tzinfo=timezone.utc)


def reading(loc, value, lat=10.0, lon=20.0, minutes_ago=30):
    when = (NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"datetime": {"utc": when}, "value": value,
            "coordinates": {"latitude": lat, "longitude": lon}, "sensorsId": loc * 10, "locationsId": loc}


def location(loc, mobile=False):
    return {"id": loc, "name": f"Station {loc}", "locality": "Town", "isMobile": mobile,
            "country": {"code": "NG"}, "provider": {"name": "Provider A"},
            "licenses": [{"attribution": {"name": "Agency A", "url": "https://example.org"}}]}


class TestBuildFrame:
    def test_keeps_valid_and_drops_bad_rows(self):
        rows = [
            reading(1, 12.34),
            reading(2, -1),                       # negative
            reading(3, 5000),                     # implausible
            reading(4, float("nan")),             # not a number
            reading(5, 10, lat=0, lon=0),         # null island
            reading(6, 10, lat=95),               # out of range
            reading(7, 10, minutes_ago=7 * 60),   # too old
            reading(8, 10, minutes_ago=-120),     # in the future
            reading(9, 10),                       # mobile sensor
            {"value": 3},                         # missing fields
        ]
        locs = {i: location(i, mobile=(i == 9)) for i in range(1, 10)}
        frame, index, stats = openaq.build_frame("pm25", rows, locs, NOW)

        assert frame["id"] == [1]
        assert frame["value"] == [12.3]
        assert stats.received == 10 and stats.kept == 1
        assert stats.dropped == {
            "implausible_value": 2, "not_a_number": 1, "bad_coordinates": 2, "too_old": 1,
            "in_future": 1, "mobile_sensor": 1, "missing_field": 1,
        }
        assert index["stations"]["1"] == ["Station 1", "Town", "NG", "Provider A"]
        assert index["attributions"] == [{"name": "Agency A", "url": "https://example.org"}]

    def test_keeps_newest_reading_per_location(self):
        rows = [reading(1, 50, minutes_ago=90), reading(1, 20, minutes_ago=10), reading(1, 70, minutes_ago=200)]
        frame, _, stats = openaq.build_frame("pm25", rows, {1: location(1)}, NOW)
        assert frame["value"] == [20.0]
        assert frame["age_min"] == [10]
        assert stats.dropped["duplicate_sensor"] == 2

    def test_columns_line_up_and_round(self):
        rows = [reading(3, 7.77, lat=1.234567, lon=2.345678), reading(1, 9.99, lat=-3.1, lon=4.2)]
        frame, _, _ = openaq.build_frame("pm25", rows, {}, NOW)
        n = frame["count"]
        assert n == 2 and all(len(frame[k]) == n for k in ("id", "lon", "lat", "value", "age_min"))
        assert frame["id"] == [1, 3]
        assert frame["lat"] == [-3.1, 1.2346]
        assert frame["value"] == [10.0, 7.8]

    def test_unknown_location_still_plotted_without_name(self):
        frame, index, _ = openaq.build_frame("pm25", [reading(42, 8)], {}, NOW)
        assert frame["id"] == [42]
        assert index["stations"]["42"] == ["", "", "", ""]


class TestPaginate:
    def test_stops_on_short_page_and_sends_limit(self):
        calls = []

        def get(url, headers):
            calls.append(url)
            page = len(calls)
            size = openaq.PAGE_LIMIT if page < 3 else 5
            return {"results": [{"id": page * 10000 + i} for i in range(size)]}

        sleeps = []
        out = list(openaq.paginate("/locations", {"parameters_id": 2}, "k", get=get, sleep=sleeps.append))
        assert len(out) == 2 * openaq.PAGE_LIMIT + 5
        assert len(calls) == 3
        assert "limit=1000" in calls[0] and "page=3" in calls[2]
        assert len(sleeps) == 2

    def test_sends_api_key_header(self):
        seen = {}

        def get(url, headers):
            seen.update(headers)
            return {"results": []}

        assert list(openaq.paginate("/x", {}, "secret", get=get, sleep=lambda s: None)) == []
        assert seen == {"X-API-Key": "secret"}


class TestRun:
    def _fake_get(self, n):
        def get(url, headers):
            if "/locations" in url:
                return {"results": [location(i) for i in range(1, n + 1)]}
            return {"results": [reading(i, 10 + i, lat=i / 10, lon=i / 10) for i in range(1, n + 1)]}
        return get

    def test_refuses_near_empty_layer(self, tmp_path):
        with pytest.raises(SystemExit, match="Refusing to publish"):
            build_stations.run(tmp_path, "k", "pm25", min_stations=10, now=NOW,
                               get=self._fake_get(3), sleep=lambda s: None)
        assert list(tmp_path.iterdir()) == []

    def test_writes_frame_index_and_stats(self, tmp_path):
        stats = build_stations.run(tmp_path, "k", "pm25", min_stations=2, now=NOW,
                                   get=self._fake_get(4), sleep=lambda s: None)
        frame = json.loads((tmp_path / "stations-pm25.json").read_text())
        assert frame["count"] == 4 and stats["kept"] == 4
        assert (tmp_path / "stations-pm25-index.json").exists()
        assert (tmp_path / "stations-pm25-stats.json").exists()

    def test_main_without_key_exits_2(self, tmp_path, monkeypatch):
        monkeypatch.delenv("OPENAQ_API_KEY", raising=False)
        assert build_stations.main(["--out", str(tmp_path)]) == 2


class FakeResp(io.BytesIO):
    def __init__(self, payload, headers=None):
        super().__init__(json.dumps(payload).encode())
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestNet:
    def test_retries_429_then_succeeds(self):
        calls, sleeps = [], []

        def opener(req, timeout):
            calls.append(req)
            if len(calls) == 1:
                raise HTTPError(req.full_url, 429, "Too Many", {"retry-after": "3"}, None)
            return FakeResp({"ok": True})

        assert net.get_json("https://x.test/a", {"X-API-Key": "k"}, opener=opener, sleep=sleeps.append) == {"ok": True}
        assert sleeps == [3.0]
        assert calls[0].get_header("X-api-key") == "k"

    def test_gives_up_after_retries(self):
        def opener(req, timeout):
            raise HTTPError(req.full_url, 503, "Down", {}, None)

        with pytest.raises(net.FetchError):
            net.get_json("https://x.test/a", opener=opener, sleep=lambda s: None, max_retries=2)

    def test_client_error_is_not_retried(self):
        calls = []

        def opener(req, timeout):
            calls.append(1)
            raise HTTPError(req.full_url, 401, "Unauthorized", {}, None)

        with pytest.raises(net.FetchError, match="401"):
            net.get_json("https://x.test/a?key=secret", opener=opener, sleep=lambda s: None)
        assert len(calls) == 1

    def test_paces_when_rate_window_used_up(self):
        sleeps = []
        opener = lambda req, timeout: FakeResp({}, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "7"})
        net.get_json("https://x.test/a", opener=opener, sleep=sleeps.append)
        assert sleeps == [7.0]


class TestFallback:
    def test_restores_last_good_frame(self, tmp_path):
        good = {"count": 3, "id": [1, 2, 3]}
        fallback.restore("https://site.test/data", tmp_path, ["stations-pm25.json"], get=lambda url: good)
        assert json.loads((tmp_path / "stations-pm25.json").read_text()) == good

    def test_refuses_empty_live_copy(self, tmp_path):
        with pytest.raises(SystemExit):
            fallback.restore("https://site.test/data", tmp_path, ["stations-pm25.json"], get=lambda url: {"count": 0})
