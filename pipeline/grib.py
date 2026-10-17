"""Read regular lat/lon GRIB fields with ecCodes (Apache-2.0)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from .raster import Grid


@dataclass
class Field:
    short_name: str
    run: datetime  # analysis/reference time, UTC
    step_h: int  # forecast lead time in hours
    level: int | None
    grid: Grid

    @property
    def valid(self) -> datetime:
        return self.run + timedelta(hours=self.step_h)


def read_fields(path: str | Path) -> list[Field]:
    import eccodes  # imported lazily so the rest of the pipeline runs without it

    fields: list[Field] = []
    with open(path, "rb") as fh:
        while True:
            gid = eccodes.codes_grib_new_from_file(fh)
            if gid is None:
                break
            try:
                if eccodes.codes_get(gid, "gridType") != "regular_ll":
                    raise ValueError("only regular lat/lon grids are supported")
                ni = eccodes.codes_get(gid, "Ni")
                nj = eccodes.codes_get(gid, "Nj")
                lat1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
                lon1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
                dlat = abs(eccodes.codes_get(gid, "jDirectionIncrementInDegrees"))
                dlon = abs(eccodes.codes_get(gid, "iDirectionIncrementInDegrees"))
                values = np.asarray(eccodes.codes_get_values(gid), dtype=np.float64)
                if eccodes.codes_get(gid, "bitmapPresent"):
                    values[values == eccodes.codes_get(gid, "missingValue")] = np.nan
                values = values.reshape(nj, ni)
                if eccodes.codes_get(gid, "jScansPositively"):  # south to north: flip to north first
                    values = values[::-1]
                    lat1 = lat1 + dlat * (nj - 1)
                date = eccodes.codes_get(gid, "dataDate")
                hhmm = eccodes.codes_get(gid, "dataTime")
                run = datetime.strptime(f"{date}{hhmm:04d}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
                step = int(eccodes.codes_get(gid, "step"))
                try:
                    level = int(eccodes.codes_get(gid, "level"))
                except Exception:
                    level = None
                fields.append(Field(
                    short_name=eccodes.codes_get(gid, "shortName"), run=run, step_h=step, level=level,
                    grid=Grid(values=values, lat0=lat1, dlat=dlat, lon0=lon1 % 360, dlon=dlon),
                ))
            finally:
                eccodes.codes_release(gid)
    return fields
