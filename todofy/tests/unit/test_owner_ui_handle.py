"""runtime/owner_ui.handle answers every outcome as a plain object and never raises: an expected refusal is its
reason, a failed D1 or storage call (JsException) is UNAVAILABLE, and anything else is a bug, INTERNAL, which no
client repeats by itself (proto/README.md, docs/gateway-contract.md §3.5).

runtime/ imports the Pyodide modules (js, pyodide.ffi, workers), so this test stands them in with minimal stubs
(as test_metrics_record.py does) and removes every module it imported afterwards.
"""

import asyncio
import sys
import types
from collections.abc import Iterator
from typing import Any

import pytest

EVENT = "0b8f5a4e-3c1d-4c52-9f0e-2d7c8b6a5f41"
OWNER = "owner@example.com"
GET_EVENT = f'{{"name": "mailEvents/{EVENT}"}}'


class Stubs(types.SimpleNamespace):
    owner_ui: Any
    JsException: type[Exception]


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stubs]:
    before = set(sys.modules)
    stubs = {name: types.ModuleType(name) for name in ("js", "pyodide", "pyodide.ffi", "workers")}
    js_exception = type("JsException", (Exception,), {})
    stubs["js"].Object = types.SimpleNamespace(fromEntries=lambda entries: dict(entries))
    stubs["pyodide.ffi"].to_js = lambda value, dict_converter=None: value
    stubs["pyodide.ffi"].JsException = js_exception
    stubs["workers"].fetch = None
    for name in ("DurableObject", "Response", "WorkerEntrypoint", "Request"):
        setattr(stubs["workers"], name, object)
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    from todofy.runtime import owner_ui

    yield Stubs(owner_ui=owner_ui, JsException=js_exception)
    for name in set(sys.modules) - before:
        if name.startswith("todofy.runtime"):
            del sys.modules[name]


class Coordinator:
    """TodofyCore's event_detail, failing with ``error`` or answering ``detail``."""

    def __init__(self, error: Exception | None = None, detail: Any = None) -> None:
        self.error, self.detail = error, detail

    async def event_detail(self, _event_id: str) -> Any:
        if self.error is not None:
            raise self.error
        return self.detail


def handle(runtime: Stubs, coordinator: Coordinator, method: str = "GetMailEvent", request: str = GET_EVENT) -> Any:
    env = types.SimpleNamespace()
    return asyncio.run(runtime.owner_ui.handle(env, coordinator, OWNER, method, request, None))


def refusal(reason: str) -> dict[str, Any]:
    return {"error": reason, "detail": None, "retry_after": None}


def test_an_expected_refusal_is_its_reason(runtime: Stubs) -> None:
    assert handle(runtime, Coordinator(detail=None)) == refusal("NOT_FOUND")
    assert handle(runtime, Coordinator(), request='{"name": 7}') == refusal("BAD_REQUEST")
    assert handle(runtime, Coordinator(), method="DeleteEverything") == refusal("NOT_FOUND")


def test_a_failed_d1_call_is_unavailable(runtime: Stubs) -> None:
    assert handle(runtime, Coordinator(error=runtime.JsException("D1_ERROR"))) == refusal("UNAVAILABLE")


def test_a_bug_is_internal_and_logs_only_the_exception_type(runtime: Stubs, capsys: pytest.CaptureFixture[str]) -> None:
    assert handle(runtime, Coordinator(error=KeyError("subject: synthetic secret"))) == refusal("INTERNAL")
    assert capsys.readouterr().out.strip() == '{"owner_ui": "internal", "rpc": "GetMailEvent", "error": "KeyError"}'


def test_an_answer_the_codec_refuses_to_write_is_internal(runtime: Stubs, monkeypatch: pytest.MonkeyPatch) -> None:
    from todofy.core import owner_ui as ui

    def refuses(_message: Any) -> str:
        raise ui.WireJsonError("a value the wire profile refuses")

    monkeypatch.setattr(runtime.owner_ui.ui, "answer", refuses)
    monkeypatch.setattr(runtime.owner_ui.ui, "mail_event", lambda _row: object())
    assert handle(runtime, Coordinator(detail={"event_id": EVENT})) == refusal("INTERNAL")


def test_an_unknown_rpc_name_is_never_logged(runtime: Stubs, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    def broken(*_args: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(runtime.owner_ui, "_answer", broken)
    assert handle(runtime, Coordinator(), method="owner@example.com") == refusal("INTERNAL")
    assert '"rpc": null' in capsys.readouterr().out
