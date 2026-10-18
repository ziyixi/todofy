"""Plus replay receipts in the object's SQLite (runtime/plus_receipts.py) on host CPython with a controlled clock:
the started/done lifecycle around the Todoist Sync, IDs-only results, a label write's binding check on resend, the
read-only fallback to D1 plus_actions, the FlowDay settlement's compare-and-set, the 30-day lookup window (nothing
deletes a receipt) and UpdatePlanLabels' replay by value.

D1 and the object's SQLite are host SQLite (plus_support.py); Todoist is a fake that runs each command UUID
once and journals its calls next to storage.sync(). The real path in workerd is tests/runtime/test_plus_receipts.py.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from ziyixi_proto.todofy.ui.v1 import plus_service_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from tests.unit.plus_support import D1, Storage, stubbed_pyodide

NOW = 1_760_000_000
DAY = 86_400
LABELS = ("office", "home", "bets", "committed", "focus", "candiate", "quarter")
LABELS += ("lead_1d", "lead_3d", "lead_1w", "lead_2w", "lead_1m")
TITLE = "Synthetic private title"
STEP = "Synthetic step title"


class Todoist:
    """Tasks by ID. A command UUID runs once (Todoist's deduplication); calls are journalled in order."""

    def __init__(self, error: type[Exception], journal: list[str]) -> None:
        self.error = error
        self.journal = journal
        self.labels = [{"id": "id-" + role, "name": role} for role in LABELS]
        self.tasks: dict[str, dict[str, Any]] = {}
        self.applied: dict[str, str] = {}  # command UUID -> the task it touched
        self.sent: list[list[dict[str, Any]]] = []
        self.closed: dict[str, int] = {}
        self.fail_sync = 0

    def add(self, task_id: str, labels: list[str], **fields: Any) -> None:
        self.tasks[task_id] = {"id": task_id, "content": TITLE, "labels": labels, "project_id": "p", **fields}

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        return {"timezone": "UTC", "labels": self.labels, "filters": []}

    async def task(self, _core: Any, task_id: str) -> dict[str, Any]:
        self.journal.append("task")
        if task_id not in self.tasks:
            raise self.error("NOT_FOUND")
        return json.loads(json.dumps(self.tasks[task_id]))

    async def list(self, _core: Any, limit: int = 200, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
        self.journal.append("list")
        return [dict(task) for task in self.tasks.values()], ""

    async def active(self, _core: Any, task_ids: list[str]) -> dict[str, dict[str, Any]]:
        self.journal.append("active")
        return {task_id: dict(self.tasks[task_id]) for task_id in task_ids if task_id in self.tasks}

    async def commands(self, _core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
        self.journal.append("sync")
        self.sent.append(commands)
        if self.fail_sync:
            self.fail_sync -= 1
            raise self.error("UNAVAILABLE")
        for command in commands:
            if command["uuid"] in self.applied:
                continue
            args = command["args"]
            if command["type"] == "item_add":
                child = f"child-{len(self.tasks)}"
                self.tasks[child] = {"id": child, "content": args["content"], "labels": [], "project_id": "p"}
                self.applied[command["uuid"]] = child
                continue
            if command["type"] == "item_reorder":
                self.applied[command["uuid"]] = ",".join(item["id"] for item in args["items"])
                for item in args["items"]:
                    self.tasks[item["id"]]["child_order"] = item["child_order"]
                continue
            self.applied[command["uuid"]] = args["id"]
            if command["type"] == "item_close":
                self.closed[args["id"]] = self.closed.get(args["id"], 0) + 1
            else:
                self.tasks[args["id"]].update({key: value for key, value in args.items() if key != "id"})
        mapping = {command["temp_id"]: self.applied[command["uuid"]] for command in commands if "temp_id" in command}
        return {"sync_status": {command["uuid"]: "ok" for command in commands}, "temp_id_mapping": mapping}


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.journal: list[str] = []
        self.d1 = D1()
        self.todoist = Todoist(runtime.todoist.PlusError, self.journal)
        for name in ("metadata", "task", "commands", "active"):
            monkeypatch.setattr(runtime.todoist, name, getattr(self.todoist, name))
        monkeypatch.setattr(runtime.todoist, "tasks", self.todoist.list)
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _timezone: "2026-10-14")  # a Wednesday
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        storage = Storage(self.journal)
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.sql = storage.sql
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TODOIST_DEFAULT_PROJECT_ID="mail"),
            plus_lock=asyncio.Lock(),
            todoist_wait=lambda _now: None,
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )
        self.at(NOW)

    def at(self, seconds: int) -> None:
        self.clock["ms"] = seconds * 1000

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request), owner=True))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def etag(self, task_id: str) -> str:
        tasks = self.call("ListPlanningTasks", page_size=200)["planning_tasks"]
        return next(task["etag"] for task in tasks if task["id"] == task_id)

    def receipts(self) -> dict[str, dict[str, Any]]:
        rows = self.sql.db.execute("SELECT * FROM plus_receipts").fetchall()
        return {row["request_id"]: dict(row) for row in rows}

    def settle(self, request_id: str, value: str | None, replace_etag: str | None = None) -> str | None:
        return asyncio.run(self.runtime.plus_receipts.settle(self.core, request_id, value, replace_etag))

    def legacy(self, request_id: str, request_hash: str, commands: Any, response: Any, created_at: int) -> None:
        """A plus_actions row as the release before wrote it."""
        stored = None if response is None else json.dumps(response)
        self.d1.db.execute(
            "INSERT INTO plus_actions VALUES (?, ?, ?, ?, ?)",
            (request_id, request_hash, json.dumps(commands), stored, created_at),
        )
        self.d1.db.commit()

    def legacy_rows(self) -> int:
        return self.d1.db.execute("SELECT count(*) FROM plus_actions").fetchone()[0]


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
        stack.todoist.add("parent", ["office", "candiate"])
        stack.todoist.add("other", ["home"])
        stack.todoist.add("step-a", [], parent_id="parent", child_order=1)
        stack.todoist.add("step-b", [], parent_id="parent", child_order=2)
        plan = stack.call("ReadPlan")["plan"]
        assert "plan" in stack.call("ConfirmPlanMapping", etag=plan["etag"], request_id=str(uuid.uuid4()))
        stack.journal.clear()
        yield stack


def request_hash(stack: Stack, method: str, request: dict[str, Any]) -> str:
    """What plus_api.handle fingerprints: the request as the wire profile reads it."""
    message = from_wire(getattr(pb, method + "Request"), request, strict=True).message
    return stack.runtime.plus.fingerprint([method, to_wire(message)])


# ---- the lifecycle -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "body"),
    [
        pytest.param("SetTaskPlan", {"task_id": "parent", "stage": "weekly"}, id="set_task_plan"),
        pytest.param("SetTaskLead", {"task_id": "parent", "deadline": "2026-10-30", "lead_days": 7}, id="lead"),
        pytest.param("CompleteTask", {"task_id": "other"}, id="complete_task"),
        pytest.param("AppendTaskSteps", {"parent_id": "parent", "steps": [{"title": STEP}]}, id="steps"),
        pytest.param("ReorderTasks", {"task_ids": ["step-b", "step-a"], "task_id": "step-b"}, id="reorder"),
    ],
)
def test_a_receipt_is_stored_before_todoist_and_keeps_only_ids_once_done(stack, method, body):
    if method.startswith("SetTask"):
        body = {**body, "etag": stack.etag("parent")}
    request_id = str(uuid.uuid4())
    stack.journal.clear()
    answer = stack.call(method, **body, request_id=request_id)
    assert "error" not in answer, answer
    # The started receipt reached storage (sync) before the Sync call that changes Todoist.
    assert stack.journal.index("storage.sync") < stack.journal.index("sync")
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
    assert stack.legacy_rows() == 0  # nothing writes plus_actions


def test_a_done_replay_answers_from_its_ids_and_a_planning_write_reads_its_task_again(stack):
    complete = {"task_id": "other", "request_id": str(uuid.uuid4())}
    first = stack.call("CompleteTask", **complete)
    stack.journal.clear()
    assert stack.call("CompleteTask", **complete) == first
    assert stack.journal == [] and stack.todoist.closed == {"other": 1}
    change = {"task_id": "parent", "etag": stack.etag("parent"), "stage": "weekly", "request_id": str(uuid.uuid4())}
    written = stack.call("SetTaskPlan", **change)
    stack.journal.clear()
    assert stack.call("SetTaskPlan", **change) == written  # the title comes from Todoist, not the receipt
    assert stack.journal == ["task"]


def test_a_started_receipt_resends_its_frozen_commands(stack):
    request = {
        "parent_id": "parent",
        "steps": [{"title": STEP}, {"title": STEP + " 2"}],
        "request_id": str(uuid.uuid4()),
    }
    stack.todoist.fail_sync = 1
    assert stack.call("AppendTaskSteps", **request) == {"error": "UNAVAILABLE"}
    receipt = stack.receipts()[request["request_id"]]
    assert receipt["state"] == "started" and STEP in receipt["commands"]  # until done
    answer = stack.call("AppendTaskSteps", **request)
    assert stack.todoist.sent[0] == stack.todoist.sent[1]
    assert len(answer["task_ids"]) == 2 and stack.receipts()[request["request_id"]]["commands"] is None


def rebind_candiate(stack: Stack, label_id: str, name: str) -> None:
    """UpdatePlanLabels: the role 'candiate' moves to a new Todoist label."""
    stack.todoist.labels.append({"id": label_id, "name": name})
    plan = stack.call("ReadPlan")["plan"]
    columns = [row for row in plan["labels"] if row["role"] in {"candiate", "focus", "committed"}]
    moved = [{**row, "id": label_id, "label": name} if row["role"] == "candiate" else row for row in columns]
    assert "plan" in stack.call("UpdatePlanLabels", labels=moved, etag=plan["etag"], request_id=str(uuid.uuid4()))


def test_a_started_label_write_resends_its_labels_under_the_same_binding(stack):
    request = {"task_id": "other", "etag": stack.etag("other"), "stage": "monthly", "request_id": str(uuid.uuid4())}
    stack.todoist.fail_sync = 1
    assert stack.call("SetTaskPlan", **request) == {"error": "UNAVAILABLE"}
    assert stack.receipts()[request["request_id"]]["plan_etag"] == stack.call("ReadPlan")["plan"]["etag"]
    assert stack.call("SetTaskPlan", **request)["task"]["stage"] == "monthly"
    assert stack.todoist.sent[0] == stack.todoist.sent[1]


def test_a_started_label_write_is_not_resent_once_its_binding_changed(stack):
    """Its frozen labels name the roles' labels when it started: after a rebinding, resending them would attach
    a label that no longer has its role, so the retry answers ETAG_MISMATCH and the extension reads the task."""
    request = {"task_id": "other", "etag": stack.etag("other"), "stage": "monthly", "request_id": str(uuid.uuid4())}
    stack.todoist.fail_sync = 1
    assert stack.call("SetTaskPlan", **request) == {"error": "UNAVAILABLE"}
    rebind_candiate(stack, "id-month", "Next month")
    assert stack.call("SetTaskPlan", **request) == {"error": "ETAG_MISMATCH"}
    assert len(stack.todoist.sent) == 1 and stack.todoist.tasks["other"]["labels"] == ["home"]
    # A completion's commands name no label: it is resent whatever the binding.
    complete = {"task_id": "other", "request_id": str(uuid.uuid4())}
    stack.todoist.fail_sync = 1
    assert stack.call("CompleteTask", **complete) == {"error": "UNAVAILABLE"}
    assert stack.receipts()[complete["request_id"]]["plan_etag"] is None
    rebind_candiate(stack, "id-later", "Later")
    assert stack.call("CompleteTask", **complete) == {"task_id": "other"}


def test_another_request_under_the_same_id_is_refused(stack):
    request_id = str(uuid.uuid4())
    stack.call("CompleteTask", task_id="other", request_id=request_id)
    assert stack.call("CompleteTask", task_id="parent", request_id=request_id) == {"error": "BAD_REQUEST"}
    assert stack.todoist.closed == {"other": 1}


def test_a_lost_receipt_turns_a_replay_into_a_rerun_that_todoist_deduplicates(stack):
    request = {"task_id": "other", "request_id": str(uuid.uuid4())}
    first = stack.call("CompleteTask", **request)
    stack.sql.db.execute("DELETE FROM plus_receipts")  # the object's storage was lost
    assert stack.call("CompleteTask", **request) == first
    assert len(stack.todoist.sent) == 2 and stack.todoist.closed == {"other": 1}


# ---- the receipts of the release before, in D1 -------------------------------------------------------------


def test_a_done_d1_receipt_answers_as_stored_and_nothing_is_written_to_d1(stack):
    request = {"task_id": "parent", "etag": "e", "stage": "weekly", "request_id": str(uuid.uuid4())}
    stored = {"task": {"id": "parent", "title": "kept by the release before"}}
    stack.legacy(request["request_id"], request_hash(stack, "SetTaskPlan", request), [], stored, NOW - DAY)
    assert stack.call("SetTaskPlan", **request) == stored
    assert stack.journal == [] and stack.receipts() == {} and stack.legacy_rows() == 1


def test_a_started_d1_receipt_resends_its_commands_and_finishes_in_the_object(stack):
    request = {"task_id": "other", "request_id": str(uuid.uuid4())}
    commands = [
        {"type": "item_close", "uuid": stack.runtime.plus.command_id(request["request_id"]), "args": {"id": "other"}}
    ]
    stack.legacy(request["request_id"], request_hash(stack, "CompleteTask", request), commands, None, NOW - DAY)
    assert stack.call("CompleteTask", **request) == {"task_id": "other"}
    assert stack.todoist.sent == [commands]
    assert stack.receipts()[request["request_id"]]["state"] == "done"
    assert stack.d1.db.execute("SELECT response FROM plus_actions").fetchone()[0] is None  # left as it was


def test_a_d1_receipt_older_than_the_window_is_not_read(stack):
    request = {"task_id": "other", "request_id": str(uuid.uuid4())}
    stale = NOW - 30 * DAY - 1
    stack.legacy(request["request_id"], "another request", [], {"task_id": "other"}, stale)
    assert stack.call("CompleteTask", **request) == {"task_id": "other"}  # not BAD_REQUEST: a new request
    assert stack.todoist.closed == {"other": 1}


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


def test_a_d1_completion_and_its_settlement_are_copied_into_the_object(stack):
    request_id = str(uuid.uuid4())
    settlement = frozen("e1")
    stack.legacy(request_id, "h", [], {"task_id": "other"}, NOW - DAY)
    stack.legacy("focus:" + request_id, request_id, json.loads(settlement), None, NOW - DAY + 5)
    assert json.loads(stack.settle(request_id, frozen("e2"))) == json.loads(settlement)
    replacement = frozen("e3")
    assert stack.settle(request_id, replacement, "e1") == replacement
    copied = stack.receipts()[request_id]
    assert copied["created_at"] == NOW - DAY and json.loads(copied["result"])["task_id"] == "other"
    assert stack.legacy_rows() == 2  # read, never written


def test_a_d1_receipt_of_another_write_holds_no_settlement(stack):
    request_id = str(uuid.uuid4())
    stack.legacy(request_id, "h", [], {"task": {"id": "parent"}}, NOW - DAY)
    assert stack.settle(request_id, frozen("e1")) is None
    assert stack.receipts() == {}


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


def test_writing_names_the_tasks_of_unfinished_writes_of_the_window(stack):
    """DeleteMailItems keeps these (runtime/plus_mail.py): an item_update, item_move or item_close names its task,
    an item_add its parent; a done write, a started deletion and one older than the window do not count."""
    sql, receipts = stack.sql, stack.runtime.plus_receipts

    def started(method: str, *commands: dict[str, Any], at: int = NOW) -> str:
        request_id = str(uuid.uuid4())
        sql.exec(
            "INSERT INTO plus_receipts (request_id, method, request_hash, state, commands, created_at)"
            " VALUES (?, ?, 'h', 'started', ?, ?)",
            request_id,
            method,
            json.dumps(list(commands)),
            at,
        )
        return request_id

    started("SetTaskPlan", {"type": "item_update", "args": {"id": "a", "labels": []}})
    started("FileMailItem", {"type": "item_update", "args": {"id": "b"}}, {"type": "item_move", "args": {"id": "b"}})
    started("AppendTaskSteps", {"type": "item_add", "args": {"content": "s", "parent_id": "c", "project_id": "p"}})
    started("CompleteTask", {"type": "item_close", "args": {"id": "d"}})
    started("DeleteMailItems", {"type": "item_delete", "args": {"id": "e"}})
    started("SetTaskLead", {"type": "item_update", "args": {"id": "f"}}, at=NOW - 30 * DAY - 1)
    receipts.finish(sql, started("SetTaskPlan", {"type": "item_update", "args": {"id": "g"}}), {"task_id": "g"})
    assert receipts.writing(sql, list("abcdefgh")) == {"a", "b", "c", "d"}
    assert receipts.writing(sql, ["b", "z"]) == {"b"} and receipts.writing(sql, []) == set()
    plan = [row[3] for row in sql.db.execute(f"EXPLAIN QUERY PLAN {receipts.WRITING}", (NOW, "[]"))]
    assert any("INDEX plus_receipts_started" in step for step in plan), plan


# ---- the Monday reset and UpdatePlanLabels --------------------------------------------------------------


def test_the_monday_reset_keeps_its_receipts_in_the_object(stack):
    stack.d1.db.execute("UPDATE plus_settings SET week_start = '2026-10-05'")
    stack.d1.db.execute("INSERT INTO plus_weeks VALUES ('parent', '2026-10-05', 1, 0)")
    stack.d1.db.commit()
    stack.todoist.tasks["parent"]["labels"] = ["committed", "office"]
    stack.core.plus_next_tick = 0
    asyncio.run(stack.runtime.plus_week.tick(stack.core))
    assert stack.todoist.tasks["parent"]["labels"] == ["focus", "office"]
    assert stack.journal.index("storage.sync") < stack.journal.index("sync")
    [receipt] = [row for key, row in stack.receipts().items() if key.startswith("week:")]
    assert receipt["state"] == "done" and receipt["result"] == "{}" and receipt["method"] == "WeekReset"
    assert stack.legacy_rows() == 0


def test_update_plan_labels_replays_by_value(stack):
    stack.todoist.labels.append({"id": "id-month", "name": "Next month"})
    plan = stack.call("ReadPlan")["plan"]
    columns = [row for row in plan["labels"] if row["role"] in {"candiate", "focus", "committed"}]
    month = [{**row, "id": "id-month", "label": "Next month"} if row["role"] == "candiate" else row for row in columns]
    request = {"labels": month, "etag": plan["etag"], "request_id": str(uuid.uuid4())}
    updated = stack.call("UpdatePlanLabels", **request)["plan"]
    assert updated["etag"] != plan["etag"]
    # Its lost answer asked again: the binding is the saved one, so it is a replay and answers the saved plan.
    assert stack.call("UpdatePlanLabels", **request)["plan"]["etag"] == updated["etag"]
    # The binding before it, with the etag before it, is outdated and never written back.
    stale = {"labels": columns, "etag": plan["etag"], "request_id": str(uuid.uuid4())}
    assert stack.call("UpdatePlanLabels", **stale) == {"error": "ETAG_MISMATCH"}
    assert stack.call("ReadPlan")["plan"]["etag"] == updated["etag"]
    assert stack.receipts() == {} and stack.legacy_rows() == 0
