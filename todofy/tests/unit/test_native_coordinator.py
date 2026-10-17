"""The native writer keeps model budgets and operator pauses, without old Todoist limits."""

import asyncio
import sys
import types
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.plus_support import ObjectSql, stubbed_pyodide
from todofy.core import intents as intent_rules

NOW = 1_792_240_000


@pytest.fixture
def coordinator(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    with stubbed_pyodide(monkeypatch) as platform:
        monkeypatch.setattr(sys.modules["workers"], "DurableObject", object, raising=False)
        monkeypatch.setattr(sys.modules["workers"], "Response", object, raising=False)
        from todofy.runtime import backup
        from todofy.runtime.coordinator import DO_SCHEMA, TodofyCore

        platform["clock"]["ms"] = NOW * 1000
        monkeypatch.setattr(backup, "holds_ledger", lambda *_args: False)
        core = TodofyCore.__new__(TodofyCore)
        core.env = types.SimpleNamespace(TASK_SOURCE="tasks", GEMINI_DAILY_TOKEN_BUDGET="12345")
        core.sql = ObjectSql()
        for statement in DO_SCHEMA:
            core.sql.exec(statement)
        core.sql.exec("UPDATE control SET todoist_blocked_until = ? WHERE id = 1", NOW + 3600)
        core.sql.exec("INSERT INTO todoist_calls VALUES (?, ?)", NOW // 60, 1000)
        day = datetime.fromtimestamp(NOW, UTC).strftime("%Y-%m-%d")
        core.sql.exec("INSERT INTO llm_usage VALUES (?, ?, ?, ?)", day, 13, 27, 2)

        async def get_alarm() -> int:
            return (NOW + 60) * 1000

        core.ctx = types.SimpleNamespace(storage=types.SimpleNamespace(getAlarm=get_alarm))
        yield core


@pytest.mark.parametrize("source", ["tasks", "todoist"])
def test_budget_response_keeps_gemini_usage_for_both_task_sources(coordinator: Any, source: str) -> None:
    coordinator.env.TASK_SOURCE = source
    budgets = asyncio.run(coordinator.budgets())
    assert isinstance(budgets, dict)
    assert budgets["gemini"]["token_budget"] == 12345
    assert budgets["gemini"]["reserved_tokens"] == 13
    assert budgets["gemini"]["used_tokens"] == 27
    assert budgets["gemini"]["calls"] == 2
    assert budgets["gemini"]["models"]
    assert budgets["gemini"]["email_models"]
    assert budgets["next_alarm_at"]
    assert (budgets["todoist"]["blocked_until"] is None) == (source == "tasks")
    assert budgets["todoist"]["window_calls"] == (0 if source == "tasks" else 1000)


def test_native_writer_ignores_old_auth_block_and_call_window_in_every_status_path(coordinator: Any) -> None:
    assert coordinator._todoist_wait(NOW) is None
    assert coordinator.intent_pause(NOW) is None
    facts = coordinator.usage_facts(NOW)
    assert facts["todoist_blocked_until"] == 0
    assert facts["todoist_window_calls"] == 0
    assert facts["used_tokens"] == 27
    # Switching sources does not erase the old source's persisted state.
    assert coordinator._control()["todoist_blocked_until"] == NOW + 3600
    coordinator.env.TASK_SOURCE = "todoist"
    assert coordinator._todoist_wait(NOW) == NOW + 3600
    assert coordinator.intent_pause(NOW)[0] == intent_rules.ErrorCode.TODOIST_BLOCKED
    coordinator.sql.exec("UPDATE control SET todoist_blocked_until = 0 WHERE id = 1")
    assert coordinator._todoist_wait(NOW) == NOW + 60


def test_native_writer_still_honors_the_explicit_operator_pause(coordinator: Any) -> None:
    coordinator.env.FORCE_PAUSE_TODOIST = "true"
    assert coordinator._todoist_wait(NOW) == 0
    assert coordinator.intent_pause(NOW)[0] == intent_rules.ErrorCode.TODOIST_PAUSED
