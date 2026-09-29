"""runtime/metrics.record is best effort: neither a failing Analytics Engine binding nor a
failing counter write in the object's SQLite may fail the step it describes.

runtime/ imports the Pyodide modules (js, pyodide.ffi, workers), so this test stands them
in with minimal stubs and removes every module it imported afterwards; the rest of the
unit suite stays host-only. tests/runtime/test_metrics_daily.py covers the same rule in
real workerd, through the ledger.
"""

import json
import sys
import types
from collections.abc import Iterator
from typing import Any

import pytest

from todofy.core.metrics import Step, StepPoint

NOW = 1_790_000_000


@pytest.fixture
def runtime_metrics(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    before = set(sys.modules)
    stubs = {name: types.ModuleType(name) for name in ("js", "pyodide", "pyodide.ffi", "workers")}
    stubs["js"].Object = types.SimpleNamespace(fromEntries=lambda entries: dict(entries))
    stubs["pyodide.ffi"].to_js = lambda value, dict_converter=None: value
    stubs["pyodide.ffi"].JsException = type("JsException", (Exception,), {})
    stubs["workers"].fetch = None
    for name in ("DurableObject", "Response", "WorkerEntrypoint", "Request"):
        setattr(stubs["workers"], name, object)
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    from todofy.runtime import metrics

    yield metrics
    for name in set(sys.modules) - before:
        if name.startswith("todofy.runtime"):
            del sys.modules[name]


class Store:
    """The object's ``ctx.storage.sql``: records ``exec`` calls, or fails every one."""

    def __init__(self, fail: bool = False) -> None:
        self.fail, self.calls = fail, []

    def exec(self, *args: Any) -> None:
        if self.fail:
            raise RuntimeError("SQLITE_FULL")
        self.calls.append(args)


class Dataset:
    def __init__(self, fail: bool = False) -> None:
        self.fail, self.points = fail, []

    def writeDataPoint(self, point: Any) -> None:
        if self.fail:
            raise RuntimeError("analytics engine down")
        self.points.append(point)


def _logged(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]


def test_counters_and_data_point_are_written(runtime_metrics: Any) -> None:
    env, store = types.SimpleNamespace(METRICS=Dataset()), Store()
    runtime_metrics.record(env, store, StepPoint(Step.TASK, "created", attempts=2), NOW)
    assert len(env.METRICS.points) == 1
    assert [call[1:] for call in store.calls] == [("2026-09-21", "todoist_creates", 2)]


def test_a_failing_counter_write_is_only_logged(runtime_metrics: Any, capsys: pytest.CaptureFixture[str]) -> None:
    env = types.SimpleNamespace(METRICS=Dataset())
    runtime_metrics.record(env, Store(fail=True), StepPoint(Step.TASK, "created", attempts=1), NOW)
    assert len(env.METRICS.points) == 1  # the data point went out before the counter failed
    assert _logged(capsys) == [{"metrics": "count_failed", "error": "RuntimeError"}]


def test_both_writes_failing_is_only_logged(runtime_metrics: Any, capsys: pytest.CaptureFixture[str]) -> None:
    env = types.SimpleNamespace(METRICS=Dataset(fail=True))
    point = StepPoint(Step.SUMMARY, "ok", model="m", tokens_in=5, tokens_out=5, attempts=1)
    runtime_metrics.record(env, Store(fail=True), point, NOW)
    assert [entry["metrics"] for entry in _logged(capsys)] == ["write_failed", "count_failed"]
