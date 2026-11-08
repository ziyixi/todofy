"""Pandas-native frozen research dataset and point-in-time panel SDK."""

from __future__ import annotations

from .client import Client, Dataset, DatasetError, Version, connect, load
from .constants import (
    ALL_METRICS,
    API,
    DATA_FAMILIES,
    DURATION_METRICS,
    FIELDS,
    INSTANT_METRICS,
    RATIO_METRICS,
    SOURCES,
    __version__,
)
from .panels import (
    KEYS,
    LIMITATIONS,
    build_candidates,
    daily_features,
    forward_returns,
    fundamental_features,
    fundamental_ratios,
    material_from_version,
    panel,
    prepare,
    prepare_fundamental_features,
    prepare_fundamental_ratios,
)

__all__ = [
    "ALL_METRICS",
    "API",
    "DATA_FAMILIES",
    "DURATION_METRICS",
    "FIELDS",
    "INSTANT_METRICS",
    "KEYS",
    "LIMITATIONS",
    "RATIO_METRICS",
    "SOURCES",
    "Client",
    "Dataset",
    "DatasetError",
    "Version",
    "__version__",
    "build_candidates",
    "connect",
    "daily_features",
    "forward_returns",
    "fundamental_features",
    "fundamental_ratios",
    "load",
    "material_from_version",
    "panel",
    "prepare",
    "prepare_fundamental_features",
    "prepare_fundamental_ratios",
]
