"""ReorderTasks (runtime/plus_order.py) through plus_api.handle on host CPython: what it costs in D1 and Tasks,
and the gates every planning write passes (setup, maintenance, the backup lease). D1 and the object's SQLite are
host SQLite and Tasks the fake of plus_support.py. The workerd path is tests/runtime/test_clients_native_tasks.py.
Synthetic tasks only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.plus_support import D1, NativeTasks, Storage, plan_ready, stubbed_pyodide


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        self.d1 = D1()
        self.tasks = NativeTasks()
        for order, name in enumerate(("a", "b", "c"), start=1):
            self.tasks.add(name, project_id="p", parent_id="parent", sort_order=float(order))
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _timezone: "2026-10-14")
        self.lease = False
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: self.lease)
        storage = Storage([])
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TASKS=self.tasks),
            plus_lock=asyncio.Lock(),
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def reorder(self, *task_ids: str, lane: str = "weekly", request_id: str = "") -> dict[str, Any]:
        return self.call(
            "ReorderTasks",
            task_ids=list(task_ids),
            task_id=task_ids[0],
            lane=lane,
            request_id=request_id or str(uuid.uuid4()),
        )


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts

        runtime = types.SimpleNamespace(plus_api=plus_api, plus_receipts=plus_receipts, clock=stubs["clock"])
        stubs["clock"]["ms"] = 1_760_000_000_000
        stack = Stack(runtime, monkeypatch)
        plan_ready(stack.d1, timezone="UTC", week="2026-10-12")
        yield stack


def test_a_reorder_reads_the_tasks_twice_and_writes_one_lane(stack):
    statements = len(stack.d1.statements)
    answer = stack.reorder("c", "a", "b")
    assert [task["id"] for task in answer["tasks"]] == ["c", "a", "b"]
    assert [task["child_order"] for task in answer["tasks"]] == [1, 2, 3]
    assert answer["lane_order"] == {"lane": "weekly", "task_ids": ["c", "a", "b"]}
    # The plan's catalog, the tasks before and after the one atomic ReorderTasks.
    assert stack.tasks.methods() == [
        "GetCatalog",
        *["GetCatalog", "ListTasks"],
        "ReorderTasks",
        "GetCatalog",
        "ListTasks",
    ]
    # The plan's ready check, the settings read, the planning state of each task read, then one batch (the IDs,
    # their Todofy IDs, the board) and the board's write.
    sent = stack.d1.statements[statements:]
    assert len(sent) == 8 and sent[-1].startswith("INSERT INTO plan_settings"), sent
    # Without a lane, Todofy keeps nothing.
    statements = len(stack.d1.statements)
    assert "lane_order" not in stack.reorder("a", "c", "b", lane="")
    assert len(stack.d1.statements) - statements == 4


def test_a_repeated_reorder_runs_once_and_a_stale_resend_is_refused(stack):
    request_id = str(uuid.uuid4())
    stack.tasks.lose.add("ReorderTasks")
    assert stack.reorder("c", "a", "b", request_id=request_id) == {"error": "UNAVAILABLE"}
    stack.tasks.lose.clear()
    # The started receipt resends its frozen positions, which Tasks applied already: answered as before.
    answer = stack.reorder("c", "a", "b", request_id=request_id)
    assert [task["id"] for task in answer["tasks"]] == ["c", "a", "b"]
    assert stack.tasks.methods().count("ReorderTasks") == 2
    assert [stack.tasks.tasks[name]["sort_order"] for name in "cab"] == [1.0, 2.0, 3.0]
    # One that never reached Tasks is resent with the etags it was built from: a sibling changed since, so Tasks
    # refuses the whole order.
    other = str(uuid.uuid4())
    stack.tasks.failures["ReorderTasks"] = [503]
    assert stack.reorder("b", "c", "a", request_id=other) == {"error": "UNAVAILABLE"}
    stack.tasks.tasks["c"]["etag"] = "9"
    assert stack.reorder("b", "c", "a", request_id=other) == {"error": "ETAG_MISMATCH"}
    assert [stack.tasks.tasks[name]["sort_order"] for name in "cab"] == [1.0, 2.0, 3.0]


def test_a_reorder_waits_for_setup_and_stops_in_maintenance_and_during_a_backup(stack):
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.reorder("b", "a") == {"error": "MAINTENANCE"}
    stack.core.env.MAINTENANCE_MODE = "false"
    stack.lease = True
    assert stack.reorder("b", "a") == {"error": "MAINTENANCE"}
    stack.lease = False
    stack.d1.db.execute("DELETE FROM plan_settings WHERE key = 'native'")
    stack.d1.db.commit()
    assert stack.reorder("b", "a") == {"error": "ACTION_NOT_ALLOWED"}
    assert "ReorderTasks" not in stack.tasks.methods()
    assert stack.call("ReorderTasks", task_ids=["a"], task_id="a") == {"error": "BAD_REQUEST"}  # no request ID


def test_native_hundred_task_reorder_is_one_generic_rpc_and_keeps_original_position_slots(monkeypatch):
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime.plus_order import _native_updates

        found = {
            str(index): {
                "id": str(index),
                "sort_order": index + 0.25,
                "_native_etag": "1",
                "project_id": "project",
                "parent_id": "parent",
                "section_id": "section",
            }
            for index in range(100)
        }
        ids = list(reversed(found))
        commands = _native_updates(found, ids, ids[0], str(uuid.uuid4()))
        [operation] = commands
        assert operation["method"] == "ReorderTasks"
        positions = operation["body"]["positions"]
        assert len(positions) == 100
        assert [row["name"] for row in positions] == [f"tasks/{task_id}" for task_id in ids]
        assert [row["sort_order"] for row in positions] == [index + 0.25 for index in range(100)]
        assert _native_updates(found, list(found), "0", str(uuid.uuid4())) == []
