"""The coordinator keeps model budgets and operator pauses; a Todoist block left in old storage is ignored."""

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
        core.env = types.SimpleNamespace(GEMINI_DAILY_TOKEN_BUDGET="12345")
        core.sql = ObjectSql()
        # The object's storage as a release that still wrote Todoist left it.
        core.sql.exec("CREATE TABLE todoist_calls (minute_bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL)")
        core.sql.exec("INSERT INTO todoist_calls VALUES (?, ?)", NOW // 60, 1000)
        for statement in DO_SCHEMA:
            core.sql.exec(statement)
        core.sql.exec("UPDATE control SET todoist_blocked_until = ? WHERE id = 1", NOW + 3600)
        day = datetime.fromtimestamp(NOW, UTC).strftime("%Y-%m-%d")
        core.sql.exec("INSERT INTO llm_usage VALUES (?, ?, ?, ?)", day, 13, 27, 2)

        async def get_alarm() -> int:
            return (NOW + 60) * 1000

        core.ctx = types.SimpleNamespace(storage=types.SimpleNamespace(getAlarm=get_alarm))
        yield core


def test_budgets_answer_the_gemini_usage_only(coordinator: Any) -> None:
    budgets = asyncio.run(coordinator.budgets())
    assert budgets["gemini"]["token_budget"] == 12345
    assert budgets["gemini"]["reserved_tokens"] == 13
    assert budgets["gemini"]["used_tokens"] == 27
    assert budgets["gemini"]["calls"] == 2
    assert budgets["gemini"]["models"]
    assert budgets["gemini"]["email_models"]
    assert budgets["next_alarm_at"]
    assert set(budgets) == {"next_alarm_at", "gemini"}


def test_an_old_auth_block_and_call_window_hold_nothing(coordinator: Any) -> None:
    assert coordinator.task_writes_wait(NOW) is None
    assert coordinator.intent_pause(NOW) is None
    assert coordinator.usage_facts(NOW) == {
        "reserved_tokens": 13,
        "used_tokens": 27,
        "calls": 2,
        "token_budget": 12345,
    }
    # The call window's table is dropped with the rest of the Todoist state.
    tables = {row.name for row in coordinator.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray()}
    assert "todoist_calls" not in tables and "plus_cache" not in tables and "mail_brief_job" not in tables


def test_the_operator_pause_still_holds_every_task_write(coordinator: Any) -> None:
    coordinator.env.FORCE_PAUSE_TODOIST = "true"
    assert coordinator.task_writes_wait(NOW) == 0
    assert coordinator.intent_pause(NOW)[0] == intent_rules.ErrorCode.TODOIST_PAUSED
