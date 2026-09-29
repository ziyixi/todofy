"""Every ledger code and every API error is driven by at least one runtime scenario.

Scenarios declare what they reach with ``@pytest.mark.reaches(...)``; this test
reads those marks (it starts no Worker), so a new code in core.vocab or
core.api_errors fails here until a scenario exercises it.
"""

import importlib
from collections.abc import Iterator
from pathlib import Path

import pytest

from todofy.core.api_errors import ApiError
from todofy.core.vocab import Code

# A correct Worker cannot be driven to an unhandled exception from outside.
UNREACHABLE = {ApiError.INTERNAL_ERROR}


def _marks() -> Iterator[tuple[str, str]]:
    for path in sorted(Path(__file__).parent.glob("test_*.py")):
        module = importlib.import_module(f"tests.runtime.{path.stem}")
        for name, test in vars(module).items():
            for mark in getattr(test, "pytestmark", []) if name.startswith("test_") else []:
                if mark.name == "reaches":
                    yield from ((str(code), f"{path.stem}::{name}") for code in mark.args)


REACHED = dict(_marks())


@pytest.mark.parametrize("code", list(Code))
def test_every_ledger_code_is_reached(code: Code) -> None:
    assert code in REACHED, f"no scenario reaches {code}"


@pytest.mark.parametrize("code", [code for code in ApiError if code not in UNREACHABLE])
def test_every_api_error_is_reached(code: ApiError) -> None:
    assert code in REACHED, f"no scenario reaches {code}"


def test_marks_name_only_known_codes() -> None:
    known = {str(code) for code in Code} | {str(code) for code in ApiError}
    assert set(REACHED) <= known, set(REACHED) - known
