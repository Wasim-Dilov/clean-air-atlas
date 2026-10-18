import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from pipeline import ember, net, pvgis

STATIC = Path(__file__).resolve().parents[2] / "data" / "static"


def ember_row(area, iso3, year, source, twh, intensity=""):
    return {"Area": area, "ISO 3 code": iso3, "Year": str(year), "Area type": "Country or economy",
            "Electricity source": source, "Generation (TWh)": str(twh), "Emissions intensity (gCO2e/kWh)": str(intensity)}


class TestEmber:
    def test_absent_sources_count_as_zero_and_totals_must_add_up(self):
        rows = [
            ember_row("Testland", "TST", 2024, "Gas", 6),
            ember_row("Testland", "TST", 2024, "Solar", 4),
            ember_row("Testland", "TST", 2024, "Total generation", 10, 300),
            ember_row("Badland", "BAD", 2024, "Gas", 6),
            ember_row("Badland", "BAD", 2024, "Total generation", 10, 300),  # sources do not add up
            ember_row("Oldland", "OLD", 2010, "Gas", 1),
            {**ember_row("Region", "", 2024, "Gas", 1), "Area type": "Region"},
        ]
        d = ember.trim(rows)
        assert list(d["countries"]) == ["TST"]
        y = d["countries"]["TST"]["years"]["2024"]
        assert y["twh"][d["fuels"].index("Gas")] == 6 and y["twh"][d["fuels"].index("Coal")] == 0
        assert y["intensity"] == 300 and d["licence"] == "CC BY 4.0"

    def test_committed_file_is_complete_and_sourced(self):
        d = json.loads((STATIC / "ember_electricity.json").read_text())
        assert d["licence"] == "CC BY 4.0" and d["url"].startswith("https://")
        assert len(d["countries"]) >= 150
        for c in d["countries"].values():
            for y in c["years"].values():
                assert abs(sum(y["twh"]) - y["total_twh"]) <= max(0.02 * y["total_twh"], 0.05)


SQUARE = {
    "type": "Topology",
    "transform": {"scale": [1, 1], "translate": [0, 0]},
    "arcs": [[[0, 0], [10, 0], [0, 10], [-10, 0], [0, -10]], [[20, 20], [2, 0], [0, 2], [-2, 0], [0, -2]]],
    "objects": {"countries": {"type": "GeometryCollection", "geometries": [
        {"type": "MultiPolygon", "id": "999", "arcs": [[[0]], [[1]]]},
    ]}},
}


class TestPvgis:
    def test_topology_decoding_and_largest_polygon_centroid(self):
        shapes = pvgis.decode_topology(SQUARE)
        assert len(shapes["999"]) == 2
        lat, lon = pvgis.representative_point(shapes["999"])
        assert (lat, lon) == (5.0, 5.0)  # the 10x10 square wins over the 2x2 one

    def test_local_time_rotation(self):
        t0 = datetime(2023, 1, 1, tzinfo=timezone.utc)
        series = [(t0 + timedelta(hours=h), float(h % 24)) for h in range(8760)]
        local = pvgis.local_hour_index(series, 1)
        assert local[1] == 0 and local[13] == 12  # UTC 12:00 is 13:00 local

    def test_monthly_typical_day(self):
        t0 = datetime(2023, 1, 1, tzinfo=timezone.utc)
        series = [(t0 + timedelta(hours=h), 100.0 if (t0 + timedelta(hours=h)).hour == 11 else 0.0) for h in range(8760)]
        days = pvgis.monthly_typical_day(series, 1)
        assert len(days) == 12 and all(len(d) == 24 for d in days)
        assert days[0][12] == 100 and days[0][11] == 0

    def test_falls_back_when_optimal_angles_fail(self):
        calls = []

        def get(url):
            calls.append(url)
            if "optimalangles" in url:
                raise net.FetchError("HTTP 500")
            rows = [{"time": f"2023{(1 + h // 744):02d}01:{h % 24:02d}10", "P": 1.0} for h in range(8760)]
            return {"inputs": {"meteo_data": {"radiation_db": "PVGIS-ERA5"}}, "outputs": {"hourly": rows}}

        series, db = pvgis.fetch_hourly(0, 0, get)
        assert len(series) == 8760 and "horizontal" in db and "ERA5" in db
        assert len(calls) == 2

    def test_committed_profiles_if_present(self):
        path = STATIC / "pv_profiles.json"
        if not path.exists():
            pytest.skip("pv_profiles.json not built yet")
        d = json.loads(path.read_text())
        assert "PVGIS" in d["credit"]
        assert len(d["sites"]["lagos"]["hourly_w_per_kwp"]) == 8760
        for c in d["countries"].values():
            assert len(c["monthly_day_w_per_kwp"]) == 12
            assert max(max(day) for day in c["monthly_day_w_per_kwp"]) < 1100  # W per kWp
