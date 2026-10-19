"""The Sunday rule through runtime/plus_api.handle and plus_week.tick with a controlled clock.

workerd has no clock control, so tests/runtime only reaches the Sunday branch on a real Sunday. Here the
runtime modules run on host CPython against D1 as SQLite (every migration), the Tasks fake of plus_support.py
and an account clock in US/Pacific. runtime/ imports the Pyodide modules, so they are stood in with minimal
stubs and every module imported is removed afterwards (as in test_owner_ui_handle.py). Synthetic tasks only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from tests.unit.plus_support import D1, NativeTasks, Storage, plan_ready, stubbed_pyodide

TIMEZONE = "America/Los_Angeles"
WEEK, NEXT = "2026-10-12", "2026-10-19"


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.d1 = D1()
        self.tasks = NativeTasks(TIMEZONE)
        monkeypatch.setattr(runtime.plus_api, "account_day", self.account_day)
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        storage = Storage([])
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.sql = storage.sql
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TASKS=self.tasks),
            plus_lock=asyncio.Lock(),
            task_writes_wait=lambda _now: None,
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )

    def at(self, local: str) -> None:
        self.clock["ms"] = int(datetime.fromisoformat(local).replace(tzinfo=ZoneInfo(TIMEZONE)).timestamp() * 1000)

    def account_day(self, timezone: str) -> str:
        return datetime.fromtimestamp(self.clock["ms"] / 1000, ZoneInfo(timezone)).date().isoformat()

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def plan(self) -> dict[str, Any]:
        return self.call("ReadPlan")["plan"]

    def scan(self) -> dict[str, dict[str, Any]]:
        """Plan's task read, which remembers every committed task under the current week."""
        return {task["id"]: task for task in self.call("ListPlanningTasks", page_size=200)["planning_tasks"]}

    def set_plan(self, task_id: str, **change: Any) -> dict[str, Any]:
        etag = self.scan()[task_id]["etag"]
        return self.call("SetTaskPlan", task_id=task_id, etag=etag, request_id=str(uuid.uuid4()), **change)

    def stage(self, task_id: str) -> str:
        """The stage Todofy's planning state holds for the task."""
        row = self.d1.db.execute(
            "SELECT s.stage FROM plan_task_state s JOIN plan_tasks t ON t.id = s.task_id WHERE t.external_id = ?",
            (task_id,),
        ).fetchone()
        return "none" if row is None else row[0]

    def revisions(self) -> dict[str, int]:
        """Each task's planning-state revision, which only a write or the rollover moves."""
        rows = self.d1.db.execute(
            "SELECT t.external_id, s.rev FROM plan_task_state s JOIN plan_tasks t ON t.id = s.task_id"
        ).fetchall()
        return {row[0]: row[1] for row in rows}

    def tasks_read(self) -> int:
        return sum(method == "GetTask" for method, _ in self.tasks.calls)

    def tick(self) -> None:
        self.core.plus_next_tick = 0
        asyncio.run(self.runtime.plus_week.tick(self.core))


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts, plus_week

        runtime = types.SimpleNamespace(
            plus_api=plus_api, plus_receipts=plus_receipts, plus_week=plus_week, clock=stubs["clock"]
        )
        stack = Stack(runtime, monkeypatch)
        stack.at("2026-10-14T09:00:00")  # Wednesday
        for task_id in ("weekday", "fresh", "goal"):
            stack.tasks.add(task_id)
        plan_ready(stack.d1, timezone=TIMEZONE, week=WEEK)
        assert stack.set_plan("weekday", stage="committed")["task"]["stage"] == "committed"
        yield stack


def test_sunday_choices_survive_monday_while_earlier_commitments_roll(stack: Stack) -> None:
    stack.at("2026-10-18T20:00:00")  # Sunday evening
    assert stack.set_plan("fresh", stage="committed")["task"]["stage"] == "committed"
    stack.scan()
    stack.tick()  # Sunday's page scans remember every committed task under the ending week
    assert stack.d1.weeks() == {"weekday": (WEEK, 1, 0), "fresh": (NEXT, 1, 0)}
    assert stack.plan()["next_week_task_ids"] == ["fresh"]
    stack.at("2026-10-19T00:00:00")  # Monday 00:00
    stack.tick()
    assert (stack.stage("weekday"), stack.stage("fresh")) == ("weekly", "committed")
    # A week later it resets like any other commitment.
    stack.at("2026-10-21T09:00:00")
    stack.scan()
    stack.at("2026-10-26T00:01:00")
    stack.tick()
    assert stack.stage("fresh") == "weekly"


def test_keeping_a_commitment_on_sunday_keeps_it_through_monday(stack: Stack) -> None:
    stack.at("2026-10-18T20:00:00")
    assert stack.set_plan("weekday", stage="committed")["task"]["stage"] == "committed"
    assert "weekday" in stack.plan()["next_week_task_ids"]
    revisions = stack.revisions()
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.stage("weekday") == "committed" and stack.revisions() == revisions


def test_a_sunday_commit_whose_confirming_read_fails_is_still_kept(stack: Stack) -> None:
    """The commit was saved, then the follow-up read failed: Plan shows the error, does not repeat the request
    and reads the page again, which shows the task committed."""
    stack.at("2026-10-18T20:00:00")
    etag = stack.scan()["fresh"]["etag"]
    stack.tasks.failures["GetTask"] = [None, 503]  # the task read the write is built from, then the confirming one
    answer = stack.call("SetTaskPlan", task_id="fresh", etag=etag, stage="committed", request_id=str(uuid.uuid4()))
    assert answer == {"error": "UNAVAILABLE"}
    assert stack.stage("fresh") == "committed"
    stack.scan()
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.stage("fresh") == "committed"


def test_a_kept_choice_removed_again_on_sunday_is_not_kept(stack: Stack) -> None:
    stack.at("2026-10-18T20:00:00")
    stack.set_plan("fresh", stage="committed")
    stack.set_plan("fresh", stage="weekly")
    assert "next_week_task_ids" not in stack.plan()  # the wire profile omits an empty list
    stack.scan()
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.stage("fresh") == "weekly" and stack.d1.weeks() == {}


def test_monday_reset_touches_no_task_without_marks(stack: Stack) -> None:
    stack.set_plan("goal", stage="monthly")
    # A commitment moved back during the week is forgotten at once: Monday has nothing to change for it.
    stack.set_plan("fresh", stage="committed")
    stack.set_plan("fresh", stage="weekly")
    assert stack.d1.weeks() == {"weekday": (WEEK, 1, 0)}
    revisions = stack.revisions()
    stack.at("2026-10-19T00:01:00")
    stack.tick()
    # The unfinished commitment only, at its next revision.
    assert stack.revisions() == {**revisions, "weekday": revisions["weekday"] + 1}
    assert stack.d1.weeks() == {}
    assert (stack.stage("weekday"), stack.stage("fresh"), stack.stage("goal")) == ("weekly", "weekly", "monthly")


def test_the_monday_reset_reads_no_task_so_an_unavailable_or_deleted_one_cannot_hold_it(stack: Stack) -> None:
    stack.tasks.failures["GetTask"] = [503]
    del stack.tasks.tasks["weekday"]  # deleted in Tasks while its reset waits
    reads = stack.tasks_read()
    stack.at("2026-10-19T00:01:00")
    stack.tick()
    assert stack.d1.weeks() == {} and stack.stage("weekday") == "weekly"
    assert stack.tasks_read() == reads
    stack.tasks.failures.clear()
    assert stack.set_plan("fresh", stage="committed")["task"]["stage"] == "committed"


@pytest.mark.parametrize("method", ["SetTaskPlan", "CompleteTask"])
def test_a_monday_write_runs_the_reset_first(stack: Stack, method: str) -> None:
    stack.at("2026-10-19T00:01:00")
    if method == "SetTaskPlan":
        request = {"task_id": "fresh", "etag": stack.scan()["fresh"]["etag"], "stage": "committed"}
    else:
        request = {"task_id": "goal"}
    assert "error" not in stack.call(method, request_id=str(uuid.uuid4()), **request)
    assert stack.stage("weekday") == "weekly" and "weekday" not in stack.d1.weeks()
