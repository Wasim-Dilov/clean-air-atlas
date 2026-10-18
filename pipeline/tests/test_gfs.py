from datetime import datetime, timezone

import numpy as np
import pytest

from pipeline import gfs, net, png

NOW = datetime(2026, 10, 17, 15, 20, tzinfo=timezone.utc)

IDX = """586:35400000:d=2026101706:TMP:2 m above ground:9 hour fcst:
587:35500000:d=2026101706:RH:2 m above ground:9 hour fcst:
588:35633177:d=2026101706:UGRD:10 m above ground:9 hour fcst:
589:35712374:d=2026101706:VGRD:10 m above ground:9 hour fcst:
590:35791570:d=2026101706:ICEG:10 m above mean sea level:9 hour fcst:
"""


def test_candidates_newest_cycle_first_with_nearest_step():
    c = gfs.candidates(NOW)
    assert c[0] == (datetime(2026, 10, 17, 12, tzinfo=timezone.utc), 3)
    assert c[1] == (datetime(2026, 10, 17, 6, tzinfo=timezone.utc), 9)
    assert len(c) == 4


def test_byte_ranges_from_idx():
    assert gfs.byte_ranges(IDX) == [(35633177, 35712373), (35712374, 35791569)]
    assert gfs.byte_ranges("1:0:d=x:UGRD:10 m above ground:anl:\n") == [(0, None)]


def test_file_url():
    url = gfs.file_url(datetime(2026, 10, 17, 6, tzinfo=timezone.utc), 9)
    assert url == "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261017/06/atmos/gfs.t06z.pgrb2.1p00.f009"


def test_pack_round_trips_within_one_step():
    u = np.array([[-10.0, 0.0], [5.0, np.nan]])
    v = np.array([[3.0, -2.0], [9.0, 1.0]])
    data, scale = gfs.pack(u, v)
    img = png.decode_rgba(data)
    step = (scale["max"] - scale["min"]) / 255
    back = scale["min"] + img[..., 0] / 255 * (scale["max"] - scale["min"])
    assert abs(back[0, 0] - -10) <= step and abs(back[1, 0] - 5) <= step
    assert img[1, 1, 3] == 0 and img[0, 0, 3] == 255


def make_uv_grib(cycle, step):
    eccodes = pytest.importorskip("eccodes")
    out = b""
    for number, value in ((2, 4.0), (3, -3.0)):  # UGRD, VGRD
        gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
        eccodes.codes_set_key_vals(gid, {
            "discipline": 0, "parameterCategory": 2, "parameterNumber": number,
            "typeOfFirstFixedSurface": 103, "scaledValueOfFirstFixedSurface": 10, "scaleFactorOfFirstFixedSurface": 0,
            "Ni": 4, "Nj": 3, "latitudeOfFirstGridPointInDegrees": 60, "latitudeOfLastGridPointInDegrees": -60,
            "longitudeOfFirstGridPointInDegrees": 0, "longitudeOfLastGridPointInDegrees": 270,
            "iDirectionIncrementInDegrees": 90, "jDirectionIncrementInDegrees": 60,
            "dataDate": int(cycle.strftime("%Y%m%d")), "dataTime": cycle.hour * 100, "step": step,
        })
        eccodes.codes_set_values(gid, np.full(12, value))
        out += eccodes.codes_get_message(gid)
        eccodes.codes_release(gid)
    return out


def test_build_skips_missing_cycle_and_writes_frame(tmp_path):
    cycle = datetime(2026, 10, 17, 6, tzinfo=timezone.utc)
    body = make_uv_grib(cycle, 9)
    half = len(body) // 2
    idx = f"1:0:d=2026101706:UGRD:10 m above ground:9 hour fcst:\n2:{half}:d=2026101706:VGRD:10 m above ground:9 hour fcst:\n"
    calls = []

    def get(url, headers=None):
        calls.append((url, (headers or {}).get("Range")))
        if "/12/" in url:
            raise net.FetchError("404")
        if url.endswith(".idx"):
            return idx.encode()
        start, end = headers["Range"].removeprefix("bytes=").split("-")
        return body[int(start): (int(end) + 1 if end else None)]

    meta = gfs.build(tmp_path, NOW, get)
    assert meta["cycle"] == "2026-10-17T06:00:00Z" and meta["valid"] == "2026-10-17T15:00:00Z"
    assert meta["width"] == 4 and meta["height"] == 3
    assert meta["max_speed"] == 5.0
    assert (tmp_path / "wind/wind.png").exists()
    assert calls[0][0].endswith("/12/atmos/gfs.t12z.pgrb2.1p00.f003.idx")


def test_build_gives_up_loudly(tmp_path):
    def get(url, headers=None):
        raise net.FetchError("404")

    with pytest.raises(net.FetchError):
        gfs.build(tmp_path, NOW, get)
