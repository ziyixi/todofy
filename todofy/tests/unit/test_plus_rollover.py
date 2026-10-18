"""The Sunday rule through runtime/plus_api.handle and plus_week.tick with a controlled clock.

workerd has no clock control, so tests/runtime only reaches the Sunday branch on a real Sunday. Here the
runtime modules run on host CPython against D1 as SQLite (every migration), a fake Todoist that applies
Sync commands once per UUID, and an account clock in US/Pacific. runtime/ imports the Pyodide modules, so
they are stood in with minimal stubs and every module imported is removed afterwards (as in
test_owner_ui_handle.py). Synthetic tasks only.
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

from tests.unit.plus_support import D1, Storage, confirm_plan, stubbed_pyodide

TIMEZONE = "America/Los_Angeles"
WEEK, NEXT = "2026-10-12", "2026-10-19"
LABELS = ("office", "home", "bets", "committed", "focus", "candiate", "quarter", "waiting")
LABELS += ("lead_1d", "lead_3d", "lead_1w", "lead_2w", "lead_1m")


class Todoist:
    """Tasks by ID; a Sync command applies once per UUID, and a missing item fails its command."""

    def __init__(self, error: type[Exception]) -> None:
        self.error = error
        self.labels = [{"id": "id-" + role, "name": role} for role in LABELS]
        self.tasks: dict[str, dict[str, Any]] = {}
        self.applied: set[str] = set()
        self.calls: list[str] = []
        self.metadata_reads: list[bool] = []  # each read's ``fresh``: whether it had to sync Todoist first
        self.fail_sync = 0
        self.fail_read_after_sync = 0

    def add(self, task_id: str, labels: list[str]) -> None:
        self.tasks[task_id] = {"id": task_id, "content": "Synthetic " + task_id, "labels": labels, "project_id": "p"}

    def labels_of(self, task_id: str) -> list[str]:
        return sorted(self.tasks[task_id]["labels"])

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        self.metadata_reads.append(fresh)
        return {"timezone": TIMEZONE, "labels": self.labels, "filters": []}

    async def list(self, _core: Any, limit: int = 200, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
        self.calls.append("list")
        return [dict(task) for task in self.tasks.values()], ""

    async def task(self, _core: Any, task_id: str) -> dict[str, Any]:
        after_sync = self.calls[-1:] == ["sync"]
        self.calls.append("task")
        if after_sync and self.fail_read_after_sync:
            self.fail_read_after_sync -= 1
            raise self.error("UNAVAILABLE")
        if task_id not in self.tasks:
            raise self.error("NOT_FOUND")
        return dict(self.tasks[task_id])

    async def commands(self, _core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
        self.calls.append("sync")
        if self.fail_sync:
            self.fail_sync -= 1
            raise self.error("UNAVAILABLE")
        for command in commands:
            if command["uuid"] in self.applied:
                continue
            if command["args"]["id"] not in self.tasks:
                raise self.error("ACTION_NOT_ALLOWED")  # plus_todoist.commands on a non-ok item status
            self.applied.add(command["uuid"])
            if command["type"] == "item_update":  # an item_close changes no label
                self.tasks[command["args"]["id"]]["labels"] = list(command["args"]["labels"])
        return {"sync_status": {command["uuid"]: "ok" for command in commands}, "temp_id_mapping": {}}


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.d1 = D1()
        self.todoist = Todoist(runtime.todoist.PlusError)
        for name in ("metadata", "task", "commands"):
            monkeypatch.setattr(runtime.todoist, name, getattr(self.todoist, name))
        monkeypatch.setattr(runtime.todoist, "tasks", self.todoist.list)
        monkeypatch.setattr(runtime.plus_api, "account_day", self.account_day)
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        env = types.SimpleNamespace(DB=self.d1, TODOIST_DEFAULT_PROJECT_ID="mail")
        storage = Storage(self.todoist.calls)
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.core = types.SimpleNamespace(
            env=env,
            plus_lock=asyncio.Lock(),
            todoist_wait=lambda _now: None,
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
        """The extension's task read, which remembers every marked task under the current week."""
        return {task["id"]: task for task in self.call("ListPlanningTasks", page_size=200)["planning_tasks"]}

    def set_plan(self, task_id: str, **change: Any) -> dict[str, Any]:
        etag = self.scan()[task_id]["etag"]
        return self.call("SetTaskPlan", task_id=task_id, etag=etag, request_id=str(uuid.uuid4()), **change)

    def tick(self) -> None:
        self.core.plus_next_tick = 0
        asyncio.run(self.runtime.plus_week.tick(self.core))

    def bind_retired_bets(self) -> None:
        """The saved setup as one confirmed before the Bets became text: it also binds the bets role."""
        [saved] = self.d1.db.execute("SELECT mapping FROM plus_settings WHERE id = 1").fetchone()
        labels = [*json.loads(saved)["labels"], {"role": "bets", "id": "id-bets", "label": "bets"}]
        mapping = {"etag": self.runtime.plus.fingerprint([labels, TIMEZONE]), "labels": labels}
        self.d1.db.execute("UPDATE plus_settings SET mapping = ? WHERE id = 1", (json.dumps(mapping),))
        self.d1.db.commit()


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.core import plus
        from todofy.runtime import plus_api, plus_receipts, plus_week
        from todofy.runtime import plus_todoist as todoist

        runtime = types.SimpleNamespace(
            plus=plus,
            plus_api=plus_api,
            plus_receipts=plus_receipts,
            plus_week=plus_week,
            todoist=todoist,
            clock=stubs["clock"],
        )
        stack = Stack(runtime, monkeypatch)
        stack.at("2026-10-14T09:00:00")  # Wednesday
        stack.todoist.add("weekday", ["office", "candiate"])
        stack.todoist.add("fresh", ["home", "focus"])
        stack.todoist.add("goal", ["home"])
        asyncio.run(confirm_plan(stack.core))
        assert stack.set_plan("weekday", stage="committed")["task"]["stage"] == "committed"
        yield stack


def test_sunday_choices_survive_monday_while_earlier_commitments_roll(stack: Stack) -> None:
    stack.at("2026-10-18T20:00:00")  # Sunday evening
    assert stack.set_plan("fresh", stage="committed")["task"]["stage"] == "committed"
    stack.scan()
    stack.tick()  # Sunday's page scans remember every marked task under the ending week
    assert stack.d1.weeks() == {"weekday": (WEEK, 1, 0), "fresh": (NEXT, 1, 0)}
    assert stack.plan()["next_week_task_ids"] == ["fresh"]
    stack.at("2026-10-19T00:00:00")  # Monday 00:00
    stack.tick()
    assert stack.todoist.labels_of("weekday") == ["focus", "office"]
    assert stack.todoist.labels_of("fresh") == ["committed", "home"]
    # A week later it resets like any other commitment.
    stack.at("2026-10-21T09:00:00")
    stack.scan()
    stack.at("2026-10-26T00:01:00")
    stack.tick()
    assert stack.todoist.labels_of("fresh") == ["focus", "home"]


def test_a_new_setup_neither_writes_nor_resets_the_retired_bets_label(stack: Stack) -> None:
    stack.todoist.tasks["goal"]["labels"] = ["bets", "home"]
    stack.at("2026-10-18T20:00:00")
    stack.todoist.calls.clear()
    assert stack.set_plan("goal", bet=True) == {"error": "BAD_REQUEST"}
    assert "sync" not in stack.todoist.calls
    assert stack.d1.weeks() == {"weekday": (WEEK, 1, 0)}  # nothing remembers the label without a binding
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.todoist.labels_of("goal") == ["bets", "home"]


def test_a_setup_that_still_binds_bets_removes_the_label_at_mondays_reset(stack: Stack) -> None:
    """Old @bets tasks are not converted: the existing reset removes the label, and nothing writes it again."""
    stack.bind_retired_bets()
    stack.todoist.tasks["goal"]["labels"] = ["bets", "home"]
    # Renaming the retired label in Todoist leaves the binding as saved, so Plus stays enabled.
    stack.todoist.labels = [
        {**label, "name": "old goals"} if label["id"] == "id-bets" else label for label in stack.todoist.labels
    ]
    assert stack.plan()["enabled"] is True
    stack.todoist.labels = [{"id": "id-" + role, "name": role} for role in LABELS]
    stack.scan()
    assert stack.d1.weeks()["goal"] == (WEEK, 0, 1)
    stack.at("2026-10-18T20:00:00")
    assert stack.set_plan("goal", bet=False) == {"error": "BAD_REQUEST"}
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.todoist.labels_of("goal") == ["home"]


def test_a_sunday_commitment_of_a_task_still_labelled_bets_keeps_both_marks(stack: Stack) -> None:
    """One membership row per task: the documented rule, not a guess about which mark was meant."""
    stack.bind_retired_bets()
    stack.todoist.tasks["weekday"]["labels"] = ["bets", "committed", "office"]
    stack.at("2026-10-18T20:00:00")
    stack.set_plan("weekday", stage="committed")
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.todoist.labels_of("weekday") == ["bets", "committed", "office"]


def test_keeping_a_commitment_writes_no_label_change(stack: Stack) -> None:
    stack.todoist.add("horizon", ["committed", "quarter", "office", "waiting"])
    stack.at("2026-10-18T20:00:00")
    assert stack.set_plan("horizon", stage="committed")["task"]["stage"] == "committed"
    assert stack.todoist.labels_of("horizon") == ["committed", "office", "quarter", "waiting"]
    assert "horizon" in stack.plan()["next_week_task_ids"]
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.todoist.labels_of("horizon") == ["committed", "office", "quarter", "waiting"]


def test_a_sunday_commit_whose_confirming_read_fails_is_still_kept(stack: Stack) -> None:
    """Todoist applied the commit, then the follow-up read failed: the extension shows the error, does not
    repeat the request and reads the page again, which shows the task committed."""
    stack.at("2026-10-18T20:00:00")
    stack.todoist.fail_read_after_sync = 1
    assert stack.set_plan("fresh", stage="committed") == {"error": "UNAVAILABLE"}
    assert stack.todoist.labels_of("fresh") == ["committed", "home"]
    stack.scan()
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.todoist.labels_of("fresh") == ["committed", "home"]


def test_a_kept_choice_removed_again_on_sunday_resets_on_monday(stack: Stack) -> None:
    stack.at("2026-10-18T20:00:00")
    stack.set_plan("fresh", stage="committed")
    stack.set_plan("fresh", stage="weekly")
    assert "next_week_task_ids" not in stack.plan()  # the wire profile omits an empty list
    # The owner commits it again in native Todoist; the page scan remembers it under the ending week.
    stack.todoist.tasks["fresh"]["labels"] = ["committed", "home"]
    stack.scan()
    stack.at("2026-10-19T00:05:00")
    stack.tick()
    assert stack.todoist.labels_of("fresh") == ["focus", "home"]


def test_monday_reset_touches_no_task_without_marks(stack: Stack) -> None:
    stack.todoist.add("waiting", ["office", "waiting"])
    stack.set_plan("waiting", stage="monthly")
    # A commitment removed in native Todoist keeps its row until Monday, which then has nothing to write.
    stack.todoist.add("dropped", ["home", "committed"])
    stack.scan()
    stack.todoist.tasks["dropped"]["labels"] = ["home"]
    assert stack.d1.weeks() == {"weekday": (WEEK, 1, 0), "dropped": (WEEK, 1, 0)}
    stack.at("2026-10-19T00:01:00")
    stack.todoist.calls.clear()
    stack.tick()
    assert stack.todoist.calls.count("sync") == 1  # the unfinished commitment only
    assert stack.d1.weeks() == {}
    assert stack.todoist.labels_of("weekday") == ["focus", "office"]
    assert stack.todoist.labels_of("dropped") == ["home"]


def test_a_task_deleted_while_its_monday_reset_waits_does_not_block_the_rollover(stack: Stack) -> None:
    stack.at("2026-10-19T00:01:00")
    stack.todoist.fail_sync = 1
    with pytest.raises(stack.runtime.todoist.PlusError):
        stack.tick()  # the reset update is stored, then Todoist answers 429
    del stack.todoist.tasks["weekday"]  # deleted in Todoist before the retry
    stack.at("2026-10-19T00:11:00")
    stack.tick()
    assert stack.d1.weeks() == {}
    assert stack.set_plan("fresh", stage="committed")["task"]["stage"] == "committed"


@pytest.mark.parametrize("switch", ["cache", "full"])
@pytest.mark.parametrize("method", ["SetTaskPlan", "CompleteTask"])
def test_a_monday_write_syncs_todoist_metadata_once(stack: Stack, method: str, switch: str) -> None:
    """The Monday reset that goes first writes labels, so it needs labels synced in this call: a label write's
    own Sync serves it, and every metadata read is a full Sync under the rollback PLUS_METADATA=full."""
    stack.core.env.PLUS_METADATA = switch
    stack.at("2026-10-19T00:01:00")
    if method == "SetTaskPlan":
        request = {"task_id": "fresh", "etag": stack.scan()["fresh"]["etag"], "stage": "committed"}
    else:
        request = {"task_id": "goal"}
    stack.todoist.metadata_reads.clear()
    assert "error" not in stack.call(method, request_id=str(uuid.uuid4()), **request)
    assert stack.todoist.labels_of("weekday") == ["focus", "office"]  # the reset ran first
    reads = stack.todoist.metadata_reads
    if switch == "full":
        assert len(reads) == 1  # one full Sync, as before the cache
    else:
        assert reads.count(True) == 1  # one incremental Sync
