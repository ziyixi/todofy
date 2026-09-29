"""Shared fixtures for host-CPython unit tests of ``todofy.core``.

tests/unit/golden holds bytes captured once from the Go service at 6c46ed4 by a
throwaway ``go test -overlay`` program that is not kept in the repository.
"""

import json
from pathlib import Path
from typing import Any

import pytest

GOLDEN_DIR = Path(__file__).parent / "golden"


class Golden:
    def bytes(self, name: str) -> bytes:
        return (GOLDEN_DIR / name).read_bytes()

    def text(self, name: str) -> str:
        return self.bytes(name).decode()

    def json(self, name: str) -> Any:
        return json.loads(self.bytes(name))


@pytest.fixture
def golden() -> Golden:
    return Golden()


@pytest.fixture
def payload(golden: Golden) -> dict[str, Any]:
    """A valid synthetic event as a mutable dict."""
    return golden.json("event_ascii.json")
