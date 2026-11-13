"""Projected frozen price reads for feature builders."""

from __future__ import annotations

import inspect
from collections.abc import Sequence
from typing import Any

import pandas as pd


def projected_prices(
    version: Any, asset_ids: Sequence[str], *, adjusted: bool, fields: Sequence[str]
) -> pd.DataFrame:
    reader = version.prices
    try:
        projected = "fields" in inspect.signature(reader).parameters
    except (TypeError, ValueError):
        projected = False
    return (
        reader(asset_ids, adjusted=adjusted, fields=fields)
        if projected
        else reader(asset_ids, adjusted=adjusted)
    )
