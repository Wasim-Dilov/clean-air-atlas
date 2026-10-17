"""Turn a regular lat/lon grid into a coloured Web Mercator image for the map.

MapLibre places image sources by their four corners in Mercator space, so the
equirectangular model grid is resampled onto Mercator rows first.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MERCATOR_MAX_LAT = 85.0511287798066  # where Web Mercator is square
BOUNDS = [[-180, MERCATOR_MAX_LAT], [180, MERCATOR_MAX_LAT], [180, -MERCATOR_MAX_LAT], [-180, -MERCATOR_MAX_LAT]]


@dataclass
class Grid:
    """Values on a regular grid; rows north to south, columns west to east."""

    values: np.ndarray  # (nlat, nlon)
    lat0: float  # latitude of the first (northernmost) row
    dlat: float  # positive row spacing in degrees
    lon0: float  # longitude of the first column
    dlon: float  # positive column spacing in degrees

    @property
    def lats(self) -> np.ndarray:
        return self.lat0 - self.dlat * np.arange(self.values.shape[0])

    @property
    def lons(self) -> np.ndarray:
        return self.lon0 + self.dlon * np.arange(self.values.shape[1])


def mercator_row_lats(height: int) -> np.ndarray:
    """Latitude at the centre of each pixel row of a square Web Mercator image."""
    y = (np.arange(height) + 0.5) / height  # 0 at top
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))


def resample_to_mercator(grid: Grid, width: int, height: int) -> np.ndarray:
    """Bilinear resample onto a (height, width) Mercator image covering the world."""
    v = grid.values.astype(np.float64)
    nlat, nlon = v.shape
    lats = mercator_row_lats(height)
    lons = -180 + (np.arange(width) + 0.5) * 360 / width

    fy = np.clip((grid.lat0 - lats) / grid.dlat, 0, nlat - 1)
    y0 = np.floor(fy).astype(int)
    y1 = np.minimum(y0 + 1, nlat - 1)
    wy = (fy - y0)[:, None]

    wraps = abs(nlon * grid.dlon - 360) < 1e-6
    fx = ((lons - grid.lon0) % 360) / grid.dlon
    if not wraps:
        fx = np.clip(fx, 0, nlon - 1)
    x0 = np.floor(fx).astype(int) % nlon
    x1 = (x0 + 1) % nlon if wraps else np.minimum(x0 + 1, nlon - 1)
    wx = (fx - np.floor(fx))[None, :]

    top = v[y0][:, x0] * (1 - wx) + v[y0][:, x1] * wx
    bottom = v[y1][:, x0] * (1 - wx) + v[y1][:, x1] * wx
    return top * (1 - wy) + bottom * wy


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def colorize(values: np.ndarray, edges: list[float], ramp: list[str], alphas: list[int]) -> np.ndarray:
    """Map values to RGBA by band. A value equal to an edge falls in the lower band.

    NaN becomes fully transparent.
    """
    if len(ramp) != len(edges) + 1 or len(alphas) != len(ramp):
        raise ValueError("need one colour and one alpha per band")
    bands = np.searchsorted(np.asarray(edges, dtype=np.float64), values, side="left")
    palette = np.array([[*hex_to_rgb(c), a] for c, a in zip(ramp, alphas)], dtype=np.uint8)
    rgba = palette[np.clip(bands, 0, len(ramp) - 1)]
    rgba[np.isnan(values)] = 0
    return rgba
