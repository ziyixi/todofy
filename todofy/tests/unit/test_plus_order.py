"""ReorderTasks (runtime/plus_order.py) through plus_api.handle on host CPython: what it costs in D1 and Todoist,
and the gates every Plus write passes (setup, maintenance, the backup lease). D1 and the object's SQLite are host
SQLite (plus_support.py); Todoist is a fake of the reads and the Sync it makes. The Sync, its receipt and the plan
read in workerd are tests/runtime/test_plus.py. Synthetic tasks only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.plus_support import D1, Storage, stubbed_pyodide

LABELS = ("office", "home", "committed", "focus", "candiate", "quarter")
LABELS += ("lead_1d", "lead_3d", "lead_1w", "lead_2w", "lead_1m")


class Todoist:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.labels = [{"id": "id-" + name, "name": name} for name in LABELS]
        self.tasks = {
            name: {"id": name, "content": "Synthetic step", "labels": [], "project_id": "p", "parent_id": "parent"}
            | {"child_order": order}
            for order, name in enumerate(("a", "b", "c"), start=1)
        }

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        self.calls.append("metadata:fresh" if fresh else "metadata")
        return {"timezone": "UTC", "labels": self.labels, "filters": []}

    async def list_tasks(self, _core: Any, limit: int = 200, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
        return [dict(task) for task in self.tasks.values()], ""

    async def active(self, _core: Any, task_ids: list[str]) -> dict[str, dict[str, Any]]:
        self.calls.append("active")
        return {task_id: dict(self.tasks[task_id]) for task_id in task_ids if task_id in self.tasks}

    async def commands(self, _core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
        self.calls.append("sync")
        for item in commands[0]["args"]["items"]:
            self.tasks[item["id"]]["child_order"] = item["child_order"]
        return {"sync_status": {command["uuid"]: "ok" for command in commands}}


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        self.d1 = D1()
        self.todoist = Todoist()
        for name in ("metadata", "active", "commands"):
            monkeypatch.setattr(runtime.todoist, name, getattr(self.todoist, name))
        monkeypatch.setattr(runtime.todoist, "tasks", self.todoist.list_tasks)
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _timezone: "2026-10-14")
        self.lease = False
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: self.lease)
        storage = Storage([])
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1),
            plus_lock=asyncio.Lock(),
            todoist_wait=lambda _now: None,
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request), owner=True))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def reorder(self, *task_ids: str, lane: str = "weekly") -> dict[str, Any]:
        return self.call(
            "ReorderTasks", task_ids=list(task_ids), task_id=task_ids[0], lane=lane, request_id=str(uuid.uuid4())
        )


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts
        from todofy.runtime import plus_todoist as todoist

        runtime = types.SimpleNamespace(plus_api=plus_api, plus_receipts=plus_receipts, todoist=todoist)
        runtime.clock = stubs["clock"]
        stubs["clock"]["ms"] = 1_760_000_000_000
        stack = Stack(runtime, monkeypatch)
        etag = stack.call("ReadPlan")["plan"]["etag"]
        assert "plan" in stack.call("ConfirmPlanMapping", etag=etag, request_id=str(uuid.uuid4()))
        stack.todoist.calls.clear()
        yield stack


def test_a_reorder_reads_the_cached_labels_twice_the_tasks_and_writes_one_lane(stack):
    statements = len(stack.d1.statements)
    answer = stack.reorder("c", "a", "b")
    assert [task["id"] for task in answer["tasks"]] == ["c", "a", "b"]
    assert [task["child_order"] for task in answer["tasks"]] == [1, 2, 3]
    assert answer["lane_order"] == {"lane": "weekly", "task_ids": ["c", "a", "b"]}
    # The cached labels (the order writes none), the tasks before and after the one Sync.
    assert stack.todoist.calls == ["metadata", "active", "sync", "active"]
    # Two settings reads, the receipt of the release before (none), then one batch (the IDs, their Todofy IDs, the
    # board) and the board's write.
    sent = stack.d1.statements[statements:]
    assert len(sent) == 7 and sent[-1].startswith("INSERT INTO plan_settings"), sent
    # Without a lane, Todofy keeps nothing.
    statements = len(stack.d1.statements)
    assert "lane_order" not in stack.reorder("a", "c", "b", lane="")
    assert len(stack.d1.statements) - statements == 3


def test_a_reorder_waits_for_setup_and_stops_in_maintenance_and_during_a_backup(stack):
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.reorder("b", "a") == {"error": "MAINTENANCE"}
    stack.core.env.MAINTENANCE_MODE = "false"
    stack.lease = True
    assert stack.reorder("b", "a") == {"error": "MAINTENANCE"}
    stack.lease = False
    stack.d1.db.execute("UPDATE plus_settings SET enabled = 0")
    stack.d1.db.commit()
    assert stack.reorder("b", "a") == {"error": "ACTION_NOT_ALLOWED"}
    assert "sync" not in stack.todoist.calls
    assert stack.call("ReorderTasks", task_ids=["a"], task_id="a") == {"error": "BAD_REQUEST"}  # no request ID
