"""Read hand-curated, sourced inputs from data/static/."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

STATIC = Path(__file__).resolve().parent.parent / "data" / "static"


@lru_cache(maxsize=None)
def load(name: str) -> Any:
    return json.loads((STATIC / name).read_text(encoding="utf-8"))


def conversion(key: str) -> float:
    return float(load("unit_conversions.json")[key]["value"])


def who_edges(parameter: str, averaging: str = "24h") -> list[float]:
    """Ascending WHO levels: guideline first, then interim targets from strictest to loosest."""
    level = load("who_guidelines.json")["pollutants"][parameter][averaging]
    its = sorted(level["interim_targets"].values())
    return [float(level["guideline"]), *[float(v) for v in its]]
