"""Run provenance: a digest over every SDK module and one run-record builder."""

from __future__ import annotations

import hashlib
import platform
from collections.abc import Iterable, Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow

from .constants import __version__

PACKAGE_DIRECTORY = Path(__file__).parent


def _digest(directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(directory.glob("*.py"), key=lambda item: item.name):
        content = hashlib.sha256(path.read_bytes()).hexdigest()
        digest.update(f"{path.name}\0{content}\n".encode())
    return digest.hexdigest()


@lru_cache(maxsize=1)
def _package_digest() -> str:
    return _digest(PACKAGE_DIRECTORY)


def code_digest(directory: str | Path | None = None) -> str:
    """SHA-256 over ``name NUL sha256(file) LF`` of every ``*.py`` module, by name.

    Without ``directory`` it covers this installed package (constants included), so a
    run record identifies the exact reader code.
    """
    return _package_digest() if directory is None else _digest(Path(directory))


def environment() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "pyarrow": pyarrow.__version__,
    }


def run_record(
    *,
    dataset_id: str,
    manifest_sha256: str,
    parameters: Mapping[str, Any],
    counts: Mapping[str, Any],
    limitations: Iterable[str],
    **sections: Any,
) -> dict[str, Any]:
    """The provenance shared by ``prepare`` (run.json), ``daily_features`` and ``panel``."""
    return {
        "dataset_id": dataset_id,
        "manifest_sha256": manifest_sha256,
        "package_version": __version__,
        "code_sha256": code_digest(),
        "environment": environment(),
        "parameters": dict(parameters),
        "counts": dict(counts),
        **sections,
        "limitations": list(limitations),
    }
