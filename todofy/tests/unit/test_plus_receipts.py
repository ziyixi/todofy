"""Plus replay receipts in the object's SQLite (runtime/plus_receipts.py) on host CPython with a controlled clock:
the started/done lifecycle around the Tasks write, IDs-only results, a planning write's plan check on resend, the
FlowDay settlement's compare-and-set and the 30-day lookup window (nothing deletes a receipt).

D1 and the object's SQLite are host SQLite, and Tasks the fake of plus_support.py, which runs each request ID once
and journals its calls next to storage.sync(). The workerd path is tests/runtime/test_clients_native_tasks.py.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.plus_support import D1, NativeTasks, Storage, plan_ready, stubbed_pyodide

NOW = 1_760_000_000
DAY = 86_400
TITLE = "Synthetic private title"
STEP = "Synthetic step title"


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.journal: list[str] = []
        self.d1 = D1()
        self.tasks = NativeTasks(journal=self.journal)
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _timezone: "2026-10-14")  # a Wednesday
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        storage = Storage(self.journal)
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
        self.at(NOW)

    def at(self, seconds: int) -> None:
        self.clock["ms"] = seconds * 1000

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def etag(self, task_id: str) -> str:
        tasks = self.call("ListPlanningTasks", page_size=200)["planning_tasks"]
        return next(task["etag"] for task in tasks if task["id"] == task_id)

    def receipts(self) -> dict[str, dict[str, Any]]:
        rows = self.sql.db.execute("SELECT * FROM plus_receipts").fetchall()
        return {row["request_id"]: dict(row) for row in rows}

    def sent(self, method: str) -> list[dict[str, Any]]:
        return [body for name, body in self.tasks.calls if name == method]

    def settle(self, request_id: str, value: str | None, replace_etag: str | None = None) -> str | None:
        return asyncio.run(self.runtime.plus_receipts.settle(self.core, request_id, value, replace_etag))


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import native_plan, plus_api, plus_receipts, plus_week

        runtime = types.SimpleNamespace(
            native_plan=native_plan,
            plus_api=plus_api,
            plus_receipts=plus_receipts,
            plus_week=plus_week,
            clock=stubs["clock"],
        )
        stack = Stack(runtime, monkeypatch)
        stack.tasks.add("parent", title=TITLE, project_id="p")
        stack.tasks.add("other", title=TITLE, project_id="p")
        stack.tasks.add("step-a", parent_id="parent", project_id="p", sort_order=1.0)
        stack.tasks.add("step-b", parent_id="parent", project_id="p", sort_order=2.0)
        plan_ready(stack.d1, timezone="UTC", week="2026-10-12")
        stack.journal.clear()
        yield stack


# ---- the lifecycle -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "body", "write"),
    [
        pytest.param("SetTaskPlan", {"task_id": "parent", "stage": "weekly"}, None, id="set_task_plan"),
        pytest.param(
            "SetTaskLead", {"task_id": "parent", "deadline": "2026-10-30", "lead_days": 7}, "UpdateTask", id="lead"
        ),
        pytest.param("CompleteTask", {"task_id": "other"}, "CompleteTask", id="complete_task"),
        pytest.param("AppendTaskSteps", {"parent_id": "parent", "steps": [{"title": STEP}]}, "CreateTask", id="steps"),
        pytest.param(
            "ReorderTasks", {"task_ids": ["step-b", "step-a"], "task_id": "step-b"}, "ReorderTasks", id="reorder"
        ),
    ],
)
def test_a_receipt_is_stored_before_the_write_and_keeps_only_ids_once_done(stack, method, body, write):
    if method.startswith("SetTask"):
        body = {**body, "etag": stack.etag("parent")}
    request_id = str(uuid.uuid4())
    stack.journal.clear()
    answer = stack.call(method, **body, request_id=request_id)
    assert "error" not in answer, answer
    # The started receipt reached storage (sync) before the Tasks write; SetTaskPlan writes Todofy's planning
    # state only.
    assert "storage.sync" in stack.journal
    if write:
        assert stack.journal.index("storage.sync") < stack.journal.index(write)
    receipt = stack.receipts()[request_id]
    assert receipt["state"] == "done" and receipt["commands"] is None and receipt["method"] == method
    stored = json.loads(receipt["result"])
    assert TITLE not in receipt["result"] and STEP not in receipt["result"]
    if method == "AppendTaskSteps":
        assert stored == {"task_ids": answer["task_ids"]}
    elif method == "ReorderTasks":
        assert stored == {}  # a repeat reads the tasks again (plus_order.reorder)
    else:
        assert stored == {"task_id": body.get("task_id")}


def test_a_done_replay_answers_from_its_ids_and_a_planning_write_reads_its_task_again(stack):
    complete = {"task_id": "other", "request_id": str(uuid.uuid4())}
    first = stack.call("CompleteTask", **complete)
    stack.journal.clear()
    assert stack.call("CompleteTask", **complete) == first
    assert stack.journal == [] and len(stack.sent("CompleteTask")) == 1
    change = {"task_id": "parent", "etag": stack.etag("parent"), "stage": "weekly", "request_id": str(uuid.uuid4())}
    written = stack.call("SetTaskPlan", **change)
    stack.journal.clear()
    assert stack.call("SetTaskPlan", **change) == written  # the title comes from Tasks, not the receipt
    assert stack.journal == ["GetCatalog", "GetCatalog", "GetTask"]


def test_a_started_receipt_resends_its_frozen_operations(stack):
    request = {
        "parent_id": "parent",
        "steps": [{"title": STEP}, {"title": STEP + " 2"}],
        "request_id": str(uuid.uuid4()),
    }
    stack.tasks.failures["CreateTask"] = [503]
    assert stack.call("AppendTaskSteps", **request) == {"error": "UNAVAILABLE"}
    receipt = stack.receipts()[request["request_id"]]
    assert receipt["state"] == "started" and STEP in receipt["commands"]  # until done
    answer = stack.call("AppendTaskSteps", **request)
    first, again, second = stack.sent("CreateTask")
    assert first == again and second["task"]["title"] == STEP + " 2"
    assert len(answer["task_ids"]) == 2 and stack.receipts()[request["request_id"]]["commands"] is None


def test_a_started_planning_write_resends_its_operation_under_the_same_plan(stack):
    request = {
        "task_id": "other",
        "etag": stack.etag("other"),
        "deadline": "2026-10-30",
        "lead_days": 7,
        "request_id": str(uuid.uuid4()),
    }
    stack.tasks.failures["UpdateTask"] = [503]
    assert stack.call("SetTaskLead", **request) == {"error": "UNAVAILABLE"}
    assert stack.receipts()[request["request_id"]]["plan_etag"] == stack.call("ReadPlan")["plan"]["etag"]
    assert stack.call("SetTaskLead", **request)["task"]["lead_days"] == 7
    first, again = stack.sent("UpdateTask")
    assert first == again and stack.tasks.tasks["other"]["deadline"] == "2026-10-30"


def test_another_request_under_the_same_id_is_refused(stack):
    request_id = str(uuid.uuid4())
    stack.call("CompleteTask", task_id="other", request_id=request_id)
    assert stack.call("CompleteTask", task_id="parent", request_id=request_id) == {"error": "BAD_REQUEST"}
    assert [body["name"] for body in stack.sent("CompleteTask")] == ["tasks/other"]


def test_a_lost_receipt_turns_a_replay_into_a_rerun_the_operation_journal_answers(stack):
    request = {"task_id": "other", "request_id": str(uuid.uuid4())}
    first = stack.call("CompleteTask", **request)
    stack.sql.db.execute("DELETE FROM plus_receipts")  # the receipt is gone, its finished operation is not
    assert stack.call("CompleteTask", **request) == first
    assert len(stack.sent("CompleteTask")) == 1 and stack.tasks.tasks["other"]["completed"]


# ---- the FlowDay settlement -----------------------------------------------------------------------------


def frozen(etag: str) -> str:
    return json.dumps({"name": "timerSession", "request_id": str(uuid.uuid4()), "etag": etag, "action": "settle"})


def test_the_first_settlement_frozen_wins_and_only_a_refused_etag_is_replaced(stack):
    request_id = str(uuid.uuid4())
    assert stack.settle(request_id, frozen("e1")) is None  # no completion yet: nothing to freeze
    stack.call("CompleteTask", task_id="other", request_id=request_id, flow_date="2026-10-14")
    assert stack.settle(request_id, None) is None
    first = frozen("e1")
    stack.journal.clear()
    assert stack.settle(request_id, first) == first
    assert stack.journal == ["storage.sync"]  # held before the gateway sends it
    assert json.loads(stack.settle(request_id, frozen("e2"))) == json.loads(first)  # a second freeze loses
    assert json.loads(stack.settle(request_id, frozen("e3"), "other-etag")) == json.loads(first)
    replacement = frozen("e4")
    assert stack.settle(request_id, replacement, "e1") == replacement  # FlowDay refused e1 (409)
    assert json.loads(stack.settle(request_id, None)) == json.loads(replacement)
    # The replay of the completion answers its IDs, never the frozen settlement.
    assert stack.call("CompleteTask", task_id="other", request_id=request_id, flow_date="2026-10-14") == {
        "task_id": "other"
    }


def test_only_a_completion_can_hold_a_settlement(stack):
    request_id = str(uuid.uuid4())
    stack.call("SetTaskPlan", task_id="parent", etag=stack.etag("parent"), stage="weekly", request_id=request_id)
    assert stack.settle(request_id, frozen("e1")) is None
    assert "focus" not in stack.receipts()[request_id]["result"]


# ---- the 30-day window ----------------------------------------------------------------------------------


def test_a_receipt_older_than_thirty_days_is_not_read_and_nothing_deletes_one(stack):
    request = {"task_id": "other", "request_id": str(uuid.uuid4())}
    stack.call("CompleteTask", **request)
    stack.at(NOW + 30 * DAY)
    assert stack.call("CompleteTask", task_id="parent", request_id=request["request_id"]) == {"error": "BAD_REQUEST"}
    stack.at(NOW + 30 * DAY + 1)
    # Past the window its request ID starts over: another request under it is a new one, which replaces it.
    assert stack.call("CompleteTask", task_id="parent", request_id=request["request_id"]) == {"task_id": "parent"}
    assert json.loads(stack.receipts()[request["request_id"]]["result"]) == {"task_id": "parent"}
    # The owner's rule, no automatic time-based deletion: no statement of the module deletes a receipt.
    module = vars(stack.runtime.plus_receipts)
    statements = [value for name, value in module.items() if name.isupper() and isinstance(value, str)]
    assert statements and not any("DELETE" in statement for statement in statements)


# ---- the Monday reset ------------------------------------------------------------------------------------


def test_the_monday_reset_keeps_its_receipts_in_the_object(stack):
    native_plan = stack.runtime.native_plan
    committed = {**native_plan.state_from_labels(["committed", "office"])}
    asyncio.run(native_plan.save_fields(stack.core.env, "parent", committed, 0, str(uuid.uuid4())))
    stack.d1.db.execute("UPDATE plus_settings SET week_start = '2026-10-05'")
    stack.d1.db.execute("INSERT INTO plus_weeks VALUES ('parent', '2026-10-05', 1, 0)")
    stack.d1.db.commit()
    stack.journal.clear()
    stack.core.plus_next_tick = 0
    asyncio.run(stack.runtime.plus_week.tick(stack.core))
    [state] = stack.d1.db.execute("SELECT stage, area FROM plan_task_state").fetchall()
    assert tuple(state) == ("weekly", "work")
    # The reset changes Todofy's planning state only: Tasks is read, never written.
    assert "storage.sync" in stack.journal
    assert not {"UpdateTask", "CompleteTask", "CreateTask"} & set(stack.journal)
    [receipt] = [row for key, row in stack.receipts().items() if key.startswith("week:")]
    assert receipt["state"] == "done" and receipt["result"] == "{}" and receipt["method"] == "WeekReset"
