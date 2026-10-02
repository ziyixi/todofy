"""Every ledger code and every API error is driven by at least one runtime scenario.

Scenarios declare what they reach with ``@pytest.mark.reaches(...)``; this test
reads those marks (it starts no Worker), so a new code in core.vocab, core.api_errors
or todofy.ui.v1's ErrorReason fails here until a scenario exercises it. The owner API's
errors are ErrorInfo reasons (upper case); the envelope's codes (lower case) are the
machine routes' and, for one release, the owner API's before todofy.ui.v1.
"""

import importlib
from collections.abc import Iterator
from pathlib import Path

import pytest
from ziyixi_proto.todofy.ui.v1 import errors_pb

from todofy.core.api_errors import ApiError
from todofy.core.vocab import Code

# A correct Worker cannot be driven to an unhandled exception from outside.
UNREACHABLE = {ApiError.INTERNAL_ERROR}
# Only the owner API before todofy.ui.v1 answered these (TodofyCore.owner_api, which only the previous gateway
# calls during this deploy; removed in the next release): the gateway's own routes never do.
BEFORE_UI_V1 = {
    ApiError.CSRF_FAILED,
    ApiError.VERSION_CONFLICT,
    ApiError.ACTION_NOT_ALLOWED,
    ApiError.ACTION_REQUEST_CONFLICT,
}
# The reasons Todofy's owner API answers: its own (todofy.ui.v1.ErrorReason) and the common ones its gateway
# answers (common.errors.v1.CommonReason; gateway/src/ui.ts REASONS), but INTERNAL, a bug.
UI_REASONS = [reason.name for reason in errors_pb.ErrorReason if reason] + [
    "BAD_REQUEST",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "UNAVAILABLE",
    "UNAUTHORIZED",
    "CSRF_FAILED",
    "ACCESS_NOT_CONFIGURED",
    "NOT_CONFIGURED",
]


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


@pytest.mark.parametrize("code", [code for code in ApiError if code not in UNREACHABLE | BEFORE_UI_V1])
def test_every_api_error_is_reached(code: ApiError) -> None:
    assert code in REACHED, f"no scenario reaches {code}"


@pytest.mark.parametrize("reason", UI_REASONS)
def test_every_owner_api_reason_is_reached(reason: str) -> None:
    assert reason in REACHED, f"no scenario reaches {reason}"


def test_marks_name_only_known_codes() -> None:
    known = {str(code) for code in Code} | {str(code) for code in ApiError} | set(UI_REASONS)
    assert set(REACHED) <= known, set(REACHED) - known
