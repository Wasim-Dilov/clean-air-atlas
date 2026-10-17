import json
from datetime import datetime, timedelta, timezone

from pipeline import history, net

T0 = datetime(2026, 10, 17, 14, 25, tzinfo=timezone.utc)


def frame(ids, values, lon=1.0):
    return {"count": len(ids), "units": "µg/m³", "id": ids, "value": values,
            "lon": [lon + i for i in ids], "lat": [2.0 + i for i in ids]}


def test_adds_hourly_frames_and_prunes_after_72_hours(tmp_path):
    for h in range(75):
        history.add_station_frame(tmp_path, "pm25", frame([1, 2], [float(h), 5.0]), T0 + timedelta(hours=h))
    manifest = json.loads((tmp_path / "stations/pm25/manifest.json").read_text())
    assert len(manifest["frames"]) == 72
    assert manifest["frames"][0]["t"] == "2026-10-17T17:00:00Z"
    assert manifest["latest"] == "2026-10-20T16:00:00Z"
    files = sorted(p.name for p in (tmp_path / "stations/pm25").glob("2026*.json"))
    assert len(files) == 72  # pruned files are deleted


def test_same_hour_replaces_frame(tmp_path):
    history.add_station_frame(tmp_path, "pm25", frame([1], [10.0]), T0)
    history.add_station_frame(tmp_path, "pm25", frame([1], [20.0]), T0 + timedelta(minutes=20))
    manifest = json.loads((tmp_path / "stations/pm25/manifest.json").read_text())
    assert len(manifest["frames"]) == 1
    data = json.loads((tmp_path / manifest["frames"][0]["file"]).read_text())
    assert data["v"] == [20.0]


def test_series_and_coords(tmp_path):
    history.add_station_frame(tmp_path, "pm25", frame([3, 17], [7.0, 8.0]), T0 - timedelta(hours=2))
    history.add_station_frame(tmp_path, "pm25", frame([3], [9.0]), T0)
    shard = json.loads((tmp_path / f"stations/pm25/series/{3 % history.SHARDS}.json").read_text())
    assert len(shard["hours"]) == 72 and shard["hours"][-1] == "2026-10-17T14:00:00Z"
    s3 = shard["series"]["3"]
    assert s3[-1] == 9.0 and s3[-2] is None and s3[-3] == 7.0
    # station 17 is not in the latest frame, so it has no series, but keeps coordinates for the slider
    other = json.loads((tmp_path / f"stations/pm25/series/{17 % history.SHARDS}.json").read_text())
    assert "17" not in other["series"]
    coords = json.loads((tmp_path / "stations/pm25/coords.json").read_text())
    assert coords["id"] == [3, 17] and coords["lon"] == [4.0, 18.0]


def test_pull_copies_live_history_and_skips_missing_files(tmp_path):
    site = {
        "https://site.test/data/stations/pm25/manifest.json": {"frames": [
            {"t": "2026-10-17T13:00:00Z", "file": "stations/pm25/20261017T13.json", "count": 1},
            {"t": "2026-10-17T12:00:00Z", "file": "stations/pm25/20261017T12.json", "count": 1},
        ]},
        "https://site.test/data/stations/pm25/20261017T13.json": {"t": "2026-10-17T13:00:00Z", "id": [1], "v": [4.0]},
        "https://site.test/data/stations/pm25/coords.json": {"id": [1], "lon": [0.5], "lat": [0.5]},
    }

    def get_json(url):
        if url not in site:
            raise net.FetchError(url)
        return site[url]

    counts = history.pull("https://site.test/data", tmp_path, ("pm25",), get_json=get_json,
                          get_bytes=lambda url: (_ for _ in ()).throw(net.FetchError(url)))
    assert counts == {"stations/pm25": 1, "model/pm25": 0}
    assert (tmp_path / "stations/pm25/20261017T13.json").exists()
    assert not (tmp_path / "stations/pm25/20261017T12.json").exists()
    # the pulled history feeds the next frame, and the missing hour is dropped from the manifest
    history.add_station_frame(tmp_path, "pm25", frame([1], [6.0]), T0)
    manifest = json.loads((tmp_path / "stations/pm25/manifest.json").read_text())
    assert [f["t"] for f in manifest["frames"]] == ["2026-10-17T13:00:00Z", "2026-10-17T14:00:00Z"]
