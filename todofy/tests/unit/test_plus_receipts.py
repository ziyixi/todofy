"""Mail's replay receipts in the object's SQLite (runtime/plus_receipts.py) on host CPython with a controlled clock:
the started/done lifecycle around ConvertMailItem's Tasks write, IDs-only results, a resend after a failure or a lost
answer, and the 30-day lookup window (nothing deletes a receipt).

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

from tests.unit.plus_support import D1, NativeTasks, Storage, stubbed_pyodide

NOW = 1_760_000_000
DAY = 86_400
SUBJECT = "Synthetic private subject"
E1, E2 = (str(uuid.UUID(int=index)) for index in (1, 2))


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime, self.clock = runtime, runtime.clock
        self.journal: list[str] = []
        self.d1 = D1()
        self.tasks = NativeTasks(journal=self.journal)
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        storage = Storage(self.journal)
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.sql = storage.sql
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TASKS=self.tasks),
            plus_lock=asyncio.Lock(),
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )
        self.at(NOW)

    def at(self, seconds: int) -> None:
        self.clock["ms"] = seconds * 1000

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def mail(self, event_id: str) -> None:
        self.d1.db.execute(
            "INSERT INTO summaries (event_id, created_at, subject, summary, model) VALUES (?, 1, ?, ?, 'm')",
            (event_id, SUBJECT, "Synthetic private summary"),
        )
        self.d1.db.commit()

    def conversion(self, event_id: str) -> dict[str, Any]:
        """A ConvertMailItem request for the entry as Mail lists it now."""
        items = self.call("ListMailItems")["mail_items"]
        etag = next(item["etag"] for item in items if item["id"] == event_id)
        return {"event_id": event_id, "etag": etag, "request_id": str(uuid.uuid4())}

    def receipts(self) -> dict[str, dict[str, Any]]:
        rows = self.sql.db.execute("SELECT * FROM plus_receipts").fetchall()
        return {row["request_id"]: dict(row) for row in rows}

    def sent(self, method: str) -> list[dict[str, Any]]:
        return [body for name, body in self.tasks.calls if name == method]


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts

        runtime = types.SimpleNamespace(plus_api=plus_api, plus_receipts=plus_receipts, clock=stubs["clock"])
        stack = Stack(runtime, monkeypatch)
        stack.mail(E1)
        stack.mail(E2)
        yield stack


# ---- the lifecycle -------------------------------------------------------------------------------------


def test_a_receipt_is_stored_before_the_write_and_keeps_only_ids_once_done(stack):
    request = stack.conversion(E1)
    stack.journal.clear()
    answer = stack.call("ConvertMailItem", **request)
    task_id = answer["task"]["id"]
    assert answer["task"] == {"id": task_id, "title": SUBJECT, "project_id": "inbox"}  # the Inbox's ID
    assert stack.journal.index("storage.sync") < stack.journal.index("CreateTask")
    receipt = stack.receipts()[request["request_id"]]
    assert (receipt["state"], receipt["method"], receipt["commands"]) == ("done", "ConvertMailItem", None)
    assert json.loads(receipt["result"]) == {"task_id": task_id} and receipt["plan_etag"] is None


def test_a_done_replay_answers_from_its_ids_and_reads_the_task_again(stack):
    request = stack.conversion(E1)
    first = stack.call("ConvertMailItem", **request)
    stack.journal.clear()
    assert stack.call("ConvertMailItem", **request) == first
    assert stack.journal == ["GetCatalog", "GetTask"] and len(stack.sent("CreateTask")) == 1


def test_a_started_receipt_resends_its_frozen_operation(stack):
    request = stack.conversion(E1)
    stack.tasks.failures["CreateTask"] = [503]
    assert stack.call("ConvertMailItem", **request) == {"error": "UNAVAILABLE"}
    receipt = stack.receipts()[request["request_id"]]
    assert receipt["state"] == "started" and SUBJECT in receipt["commands"]  # until done
    answer = stack.call("ConvertMailItem", **request)
    first, again = stack.sent("CreateTask")
    assert first == again and stack.receipts()[request["request_id"]]["commands"] is None
    assert answer["task"]["id"] == first["task_id"]


def test_a_lost_answer_is_replayed_by_tasks_and_creates_one_task(stack):
    request = stack.conversion(E1)
    stack.tasks.lose.add("CreateTask")
    assert stack.call("ConvertMailItem", **request) == {"error": "UNAVAILABLE"}
    stack.tasks.lose.clear()
    before = set(stack.tasks.tasks)
    answer = stack.call("ConvertMailItem", **request)
    assert len(stack.sent("CreateTask")) == 2 and set(stack.tasks.tasks) == before  # Tasks' receipt answered
    assert answer["task"]["id"] in before


def test_another_request_under_the_same_id_is_refused(stack):
    request = stack.conversion(E1)
    stack.call("ConvertMailItem", **request)
    other = {**stack.conversion(E2), "request_id": request["request_id"]}
    assert stack.call("ConvertMailItem", **other) == {"error": "BAD_REQUEST"}
    assert len(stack.sent("CreateTask")) == 1


def test_a_lost_receipt_turns_a_replay_into_a_rerun_tasks_deduplicates(stack):
    request = stack.conversion(E1)
    first = stack.call("ConvertMailItem", **request)
    # The receipt and the triage link are gone (the boundary a failure between Tasks and D1 leaves), the task is not.
    stack.sql.db.execute("DELETE FROM plus_receipts")
    stack.d1.db.execute("UPDATE summaries SET task_id = '', triaged_at = NULL WHERE event_id = ?", (E1,))
    stack.d1.db.commit()
    assert stack.call("ConvertMailItem", **stack.conversion(E1)) == first
    assert len(stack.tasks.tasks) == 1


# ---- the 30-day window ----------------------------------------------------------------------------------


def test_a_receipt_older_than_thirty_days_is_not_read_and_nothing_deletes_one(stack):
    request = stack.conversion(E1)
    stack.call("ConvertMailItem", **request)
    other = {"event_ids": [E2], "request_id": request["request_id"]}
    stack.at(NOW + 30 * DAY)
    assert stack.call("DeleteMailSummaries", **other) == {"error": "BAD_REQUEST"}
    stack.at(NOW + 30 * DAY + 1)
    # Past the window its request ID starts over: another request under it is a new one, which replaces it.
    assert stack.call("DeleteMailSummaries", **other) == {"deleted_event_ids": [E2]}
    assert stack.receipts()[request["request_id"]]["method"] == "DeleteMailSummaries"
    # The owner's rule, no automatic time-based deletion: no statement of the module deletes a receipt.
    module = vars(stack.runtime.plus_receipts)
    statements = [value for name, value in module.items() if name.isupper() and isinstance(value, str)]
    assert statements and not any("DELETE" in statement for statement in statements)
