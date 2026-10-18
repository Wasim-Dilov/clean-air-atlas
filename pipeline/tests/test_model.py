import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from pipeline import ads, cams, grib, net, openaq, png, raster, static

ROOT = Path(__file__).resolve().parents[2]


class TestRaster:
    def test_mercator_rows_are_symmetric_and_bounded(self):
        lats = raster.mercator_row_lats(8)
        assert lats[0] < raster.MERCATOR_MAX_LAT and lats[0] > 80
        np.testing.assert_allclose(lats, -lats[::-1])

    def test_resample_follows_latitude(self):
        # value = latitude, on a 1-degree global grid
        lats = 90 - np.arange(181)
        grid = raster.Grid(np.repeat(lats[:, None], 360, axis=1).astype(float), 90, 1, 0, 1)
        img = raster.resample_to_mercator(grid, 16, 64)
        np.testing.assert_allclose(img[:, 0], raster.mercator_row_lats(64), atol=1e-6)

    def test_resample_wraps_longitude(self):
        lons = np.arange(360.0)  # value = longitude in 0..359
        grid = raster.Grid(np.repeat(lons[None, :], 181, axis=0), 90, 1, 0, 1)
        img = raster.resample_to_mercator(grid, 360, 4)
        # first pixel centre is at -179.5 = 180.5 east
        assert img[0, 0] == pytest.approx(180.5)
        # between 359 and 0 the bilinear weight wraps instead of clamping
        assert 0 <= img[0, 179] <= 359

    def test_colorize_bands_edges_and_nan(self):
        edges = [15, 25]
        rgba = raster.colorize(np.array([[10.0, 15.0, 15.1, np.nan, 99.0]]), edges,
                               ["#000000", "#ff0000", "#ffffff"], [0, 100, 200])
        assert rgba[0, 0].tolist() == [0, 0, 0, 0]
        assert rgba[0, 1].tolist() == [0, 0, 0, 0]  # equal to the guideline: first band
        assert rgba[0, 2].tolist() == [255, 0, 0, 100]
        assert rgba[0, 3].tolist() == [0, 0, 0, 0]  # missing: transparent
        assert rgba[0, 4].tolist() == [255, 255, 255, 200]


def test_png_round_trip():
    img = np.random.default_rng(0).integers(0, 256, size=(5, 7, 4), dtype=np.uint8)
    np.testing.assert_array_equal(png.decode_rgba(png.encode_rgba(img)), img)


@pytest.mark.parametrize("name,ramp", [("PM25_RAMP", cams.PM25_RAMP), ("NO2_RAMP", cams.NO2_RAMP)])
def test_pipeline_ramp_matches_web_ramp(name, ramp):
    ts = (ROOT / "web/src/bands.ts").read_text()
    web = re.search(rf"{name} = \[([^\]]+)\]", ts).group(1)
    assert re.findall(r"#[0-9a-f]{6}", web) == ramp


@pytest.mark.parametrize("parameter", cams.PARAMETERS)
def test_one_colour_and_alpha_per_who_band(parameter):
    ramp, alphas = cams.STYLE[parameter]
    assert len(ramp) == len(alphas) == len(static.who_edges(parameter)) + 1
    assert alphas[0] == 0  # meeting the guideline stays clear


class TestCamsRun:
    @pytest.mark.parametrize("now,run", [
        ("2026-10-17T09:59:00", "2026-10-16T12:00:00"),
        ("2026-10-17T10:00:00", "2026-10-17T00:00:00"),
        ("2026-10-17T21:59:00", "2026-10-17T00:00:00"),
        ("2026-10-17T22:30:00", "2026-10-17T12:00:00"),
    ])
    def test_latest_guaranteed_run(self, now, run):
        got = cams.latest_run(datetime.fromisoformat(now).replace(tzinfo=timezone.utc))
        assert got == datetime.fromisoformat(run).replace(tzinfo=timezone.utc)

    def test_request(self):
        req = cams.build_request(datetime(2026, 10, 17, 12, tzinfo=timezone.utc))
        assert req["variable"] == ["particulate_matter_2.5um"]
        assert req["date"] == ["2026-10-17/2026-10-17"] and req["time"] == ["12:00"]
        assert req["leadtime_hour"][0] == "0" and req["leadtime_hour"][-1] == "120"
        assert req["data_format"] == "grib"
        assert "model_level" not in req

    def test_no2_requests_share_run_and_leads(self):
        run = datetime(2026, 10, 17, 12, tzinfo=timezone.utc)
        no2 = cams.build_request(run, cams.NO2_VARIABLES, cams.NO2_MODEL_LEVEL)
        met = cams.build_request(run, cams.MET_VARIABLES)
        assert no2["variable"] == ["nitrogen_dioxide"] and no2["model_level"] == ["137"]
        assert met["variable"] == ["surface_pressure", "2m_temperature"] and "model_level" not in met
        for key in ("date", "time", "leadtime_hour", "type", "data_format"):
            assert no2[key] == met[key]


class FakeADS:
    """Answers each request with the bytes registered for its first variable."""

    def __init__(self, responses):
        self.responses, self.calls = responses, []

    def retrieve(self, dataset, request):
        self.calls.append((dataset, request))
        return self.responses[request["variable"][0]]


def make_grib(path, run, steps, value, keys=None, append=False):
    eccodes = pytest.importorskip("eccodes")
    with open(path, "ab" if append else "wb") as fh:
        for step in steps:
            gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
            if keys:
                eccodes.codes_set_key_vals(gid, keys)
            eccodes.codes_set_key_vals(gid, {
                "Ni": 4, "Nj": 3, "latitudeOfFirstGridPointInDegrees": 60, "latitudeOfLastGridPointInDegrees": -60,
                "longitudeOfFirstGridPointInDegrees": 0, "longitudeOfLastGridPointInDegrees": 270,
                "iDirectionIncrementInDegrees": 90, "jDirectionIncrementInDegrees": 60,
                "dataDate": int(run.strftime("%Y%m%d")), "dataTime": run.hour * 100, "step": step,
            })
            eccodes.codes_set_values(gid, np.full(12, value))
            eccodes.codes_write(gid, fh)
            eccodes.codes_release(gid)


class TestCamsUpdate:
    NOW = datetime(2026, 10, 17, 11, 0, tzinfo=timezone.utc)

    def test_renders_frames_and_skips_when_up_to_date(self, tmp_path):
        run = cams.latest_run(self.NOW)
        grib_path = tmp_path / "in.grib"
        make_grib(grib_path, run, [0, 3, 6], 40e-9)  # 40 µg/m³
        client = FakeADS({"particulate_matter_2.5um": grib_path.read_bytes()})
        out = tmp_path / "out"
        manifest = cams.update(out, self.NOW, client)
        assert len(client.calls) == 1
        assert [f["lead"] for f in manifest["frames"]] == [0, 3, 6]
        assert manifest["latest_run"] == "2026-10-17T00:00:00Z"
        img = png.decode_rgba((out / manifest["frames"][0]["file"]).read_bytes())
        assert img.shape == (cams.IMAGE_SIZE, cams.IMAGE_SIZE, 4)
        band = int(np.searchsorted(static.who_edges("pm25"), 40.0, side="left"))
        assert img[cams.IMAGE_SIZE // 2, 10].tolist() == [*raster.hex_to_rgb(cams.PM25_RAMP[band]), cams.PM25_ALPHAS[band]]

        cams.update(out, self.NOW, client)
        assert len(client.calls) == 1  # same run already present: no new ADS request

    @pytest.mark.parametrize("parameter", cams.PARAMETERS)
    def test_without_key_keeps_frames_and_prunes_old(self, tmp_path, parameter):
        out = tmp_path
        base = f"model/{parameter}"
        old = out / base / "20261010T00.png"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"x")
        recent = out / base / "20261017T03.png"
        recent.write_bytes(b"y")
        (out / base / "manifest.json").write_text(json.dumps({"frames": [
            {"valid": "2026-10-10T00:00:00Z", "run": "2026-10-09T12:00:00Z", "lead": 12, "file": f"{base}/20261010T00.png"},
            {"valid": "2026-10-17T03:00:00Z", "run": "2026-10-16T12:00:00Z", "lead": 15, "file": f"{base}/20261017T03.png"},
        ]}))
        manifest = cams.update(out, self.NOW, None, parameter)
        assert manifest["parameter"] == parameter
        assert [f["valid"] for f in manifest["frames"]] == ["2026-10-17T03:00:00Z"]
        assert not old.exists() and recent.exists()


SP_PA, T2M_K = 100_000.0, 290.0
NO2_KG_KG = 50e-9  # about 60 µg/m³ at that pressure and temperature: WHO band 2 (50 to 120)


def no2_responses(tmp_path, run, no2_steps, met_steps, sp=SP_PA):
    no2_path, met_path = tmp_path / "no2.grib", tmp_path / "met.grib"
    make_grib(no2_path, run, no2_steps, NO2_KG_KG, {"shortName": "no2", "typeOfLevel": "hybrid", "level": 137})
    make_grib(met_path, run, met_steps, sp, {"shortName": "sp"})
    make_grib(met_path, run, met_steps, T2M_K, {"shortName": "2t"}, append=True)
    return {"nitrogen_dioxide": no2_path.read_bytes(), "surface_pressure": met_path.read_bytes()}


def field(short_name, value, step=0, shape=(3, 4)):
    run = datetime(2026, 10, 17, tzinfo=timezone.utc)
    return grib.Field(short_name, run, step, None, raster.Grid(np.full(shape, value), 60, 60, 0, 90))


class TestNO2Model:
    NOW = datetime(2026, 10, 17, 11, 0, tzinfo=timezone.utc)

    def test_gas_constant_is_sourced(self):
        entry = static.load("unit_conversions.json")["dry_air_gas_constant"]
        assert entry["value"] == 287.0597 and entry["units"] == "J kg-1 K-1"
        assert "IFS Documentation" in entry["source"] and entry["year"] == 2021 and entry["url"].startswith("https://www.ecmwf.int/")

    def test_air_density_matches_standard_sea_level(self):
        # 101325 Pa and 288.15 K give the standard-atmosphere sea-level density, 1.225 kg/m³.
        assert cams.air_density(np.array(101325.0), np.array(288.15)) == pytest.approx(1.225, abs=1e-3)

    def test_mixing_ratio_to_ugm3(self):
        frames = cams.no2_ugm3([field("no2", NO2_KG_KG)], [field("sp", SP_PA), field("2t", T2M_K)])
        expected = NO2_KG_KG * SP_PA / (static.conversion("dry_air_gas_constant") * T2M_K) * 1e9
        assert expected == pytest.approx(60.06, abs=0.01)
        np.testing.assert_allclose(frames[0][1], expected)

    def test_skips_steps_without_surface_fields(self):
        no2 = [field("no2", NO2_KG_KG, step) for step in (0, 3)]
        frames = cams.no2_ugm3(no2, [field("sp", SP_PA, 0), field("2t", T2M_K, 0), field("sp", SP_PA, 3)])
        assert [f.step_h for f, _ in frames] == [0]

    def test_no_matching_step_fails_loudly(self):
        with pytest.raises(RuntimeError, match="no NO2 step"):
            cams.no2_ugm3([field("no2", NO2_KG_KG, 3)], [field("sp", SP_PA, 0), field("2t", T2M_K, 0)])

    def test_rejects_pressure_in_wrong_units(self):
        with pytest.raises(RuntimeError, match="implausible air density"):
            cams.no2_ugm3([field("no2", NO2_KG_KG)], [field("sp", 1000.0), field("2t", T2M_K)])  # hPa, not Pa

    def test_rejects_mismatched_grids(self):
        with pytest.raises(RuntimeError, match="different grids"):
            cams.no2_ugm3([field("no2", NO2_KG_KG)], [field("sp", SP_PA, shape=(2, 4)), field("2t", T2M_K)])

    def test_renders_frames_from_two_requests(self, tmp_path):
        run = cams.latest_run(self.NOW)
        client = FakeADS(no2_responses(tmp_path, run, [0, 3, 6], [0, 3, 6]))
        out = tmp_path / "out"
        manifest = cams.update(out, self.NOW, client, "no2")
        assert [c[1]["variable"][0] for c in client.calls] == ["nitrogen_dioxide", "surface_pressure"]
        assert client.calls[0][1]["model_level"] == ["137"]
        assert {c[1]["time"][0] for c in client.calls} == {"00:00"}
        assert manifest["parameter"] == "no2" and "Approximate" in manifest["note"]
        assert [f["lead"] for f in manifest["frames"]] == [0, 3, 6]
        assert all(f["file"].startswith("model/no2/") for f in manifest["frames"])
        assert json.loads((out / "model/no2/manifest.json").read_text())["latest_run"] == "2026-10-17T00:00:00Z"
        img = png.decode_rgba((out / manifest["frames"][0]["file"]).read_bytes())
        band = int(np.searchsorted(static.who_edges("no2"), 60.06, side="left"))
        assert band == 2
        assert img[cams.IMAGE_SIZE // 2, 10].tolist() == [*raster.hex_to_rgb(cams.NO2_RAMP[band]), cams.NO2_ALPHAS[band]]

        cams.update(out, self.NOW, client, "no2")
        assert len(client.calls) == 2  # same run already present: no new ADS request

    def test_one_layer_failing_does_not_block_the_other(self, tmp_path):
        run = cams.latest_run(self.NOW)
        responses = no2_responses(tmp_path, run, [0, 3], [0, 3])
        responses["particulate_matter_2.5um"] = b""  # decodes to no fields
        out = tmp_path / "out"
        assert cams.update_all(out, self.NOW, FakeADS(responses)) == ["pm25"]
        assert not (out / "model/pm25/manifest.json").exists()
        assert len(json.loads((out / "model/no2/manifest.json").read_text())["frames"]) == 2


class TestSharedDeadline:
    def test_budget_is_shared_across_requests(self):
        now = [0.0]

        class Client:
            timeout_s = None

            def retrieve(self, dataset, request):
                now[0] += 400  # each request takes 400 s
                return b"ok"

        client = Client()
        budget = cams.SharedDeadline(client, 1000, clock=lambda: now[0])
        assert budget.retrieve("d", {}) == b"ok" and client.timeout_s == 1000
        assert budget.retrieve("d", {}) == b"ok" and client.timeout_s == 600
        budget.retrieve("d", {})
        assert client.timeout_s == 200
        with pytest.raises(ads.ADSError, match="budget"):
            budget.retrieve("d", {})


class TestADS:
    def test_submit_poll_download(self):
        replies = iter([
            json.dumps({"jobID": "j1", "status": "accepted"}).encode(),
            json.dumps({"status": "running"}).encode(),
            json.dumps({"status": "successful"}).encode(),
            json.dumps({"asset": {"value": {"href": "https://dl.test/f.grib", "file:size": 3}}}).encode(),
            b"abc",
        ])
        sent = []

        def send(url, headers, data=None, method=None):
            sent.append((url, headers.get("PRIVATE-TOKEN"), method))
            return next(replies)

        client = ads.ADSClient(key="tok", send=send, sleep=lambda s: None)
        assert client.retrieve("cams-x", {"variable": ["v"]}) == b"abc"
        assert sent[0] == ("https://ads.atmosphere.copernicus.eu/api/retrieve/v1/processes/cams-x/execution", "tok", "POST")
        assert sent[1][0].endswith("/retrieve/v1/jobs/j1")
        assert sent[3][0].endswith("/retrieve/v1/jobs/j1/results")

    def test_times_out_gracefully(self):
        clock = iter(range(0, 10_000, 100))
        client = ads.ADSClient(key="t", timeout_s=250, sleep=lambda s: None, clock=lambda: next(clock),
                               send=lambda *a, **k: json.dumps({"jobID": "j", "status": "accepted"}).encode())
        with pytest.raises(ads.ADSError, match="still accepted"):
            client.retrieve("d", {})

    def test_failed_job(self):
        replies = iter([json.dumps({"jobID": "j", "status": "accepted"}).encode(), json.dumps({"status": "failed"}).encode()])
        client = ads.ADSClient(key="t", sleep=lambda s: None, send=lambda *a, **k: next(replies))
        with pytest.raises(ads.ADSError, match="failed"):
            client.retrieve("d", {})


class TestNO2:
    def test_unit_factors_come_from_static_file(self):
        assert openaq.unit_factor("no2", "ppm") == static.conversion("no2_ppm_to_ugm3") == 1914
        assert openaq.unit_factor("no2", "µg/m³") == 1.0
        assert openaq.unit_factor("pm25", "ppm") is None

    def test_resolves_ids_by_name_and_converts_values(self):
        def get(url, headers):
            if "/parameters?" in url:
                return {"results": [{"id": 7, "name": "no2", "units": "ppm"}, {"id": 5, "name": "no2", "units": "µg/m³"},
                                    {"id": 2, "name": "pm25", "units": "µg/m³"}, {"id": 99, "name": "no2", "units": "furlongs"}]}
            if "/parameters/7/latest" in url:
                return {"results": [{"value": 0.02, "locationsId": 1}]}
            if "/parameters/5/latest" in url:
                return {"results": [{"value": 30.0, "locationsId": 2}]}
            raise AssertionError(url)

        ids = openaq.resolve("k", "no2", get=get, sleep=lambda s: None)
        assert ids == [(7, 1914.0), (5, 1.0)]
        rows = openaq.fetch_latest("k", ids, datetime(2026, 10, 17, tzinfo=timezone.utc), get=get, sleep=lambda s: None)
        assert [round(r["value"], 2) for r in rows] == [38.28, 30.0]

    def test_no_usable_ids_fails(self):
        get = lambda url, headers: {"results": [{"id": 7, "name": "no2", "units": "furlongs"}]}
        with pytest.raises(net.FetchError):
            openaq.resolve("k", "no2", get=get, sleep=lambda s: None)
