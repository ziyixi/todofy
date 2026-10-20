"""Mail's RPCs through runtime/plus_api.handle on host CPython: ListMailItems, ReadMailSummary, ReadMailSettings,
UpdateMailCategories and DeleteMailSummaries.

D1 is host SQLite with every migration and the object's SQLite another, and Tasks the fake of plus_support.py,
which journals every call. Synthetic mail and tasks only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.plus_support import D1, NativeTasks, Storage, stubbed_pyodide

LABELS = ("office", "home", "committed", "focus", "candiate", "quarter", "lead_1d", "lead_3d", "lead_1w", "lead_2w")
LABELS += ("lead_1m", "quick", "deep", "active")
NOW = datetime(2026, 10, 16, 16, 0, tzinfo=UTC)


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        runtime.clock["ms"] = int(NOW.timestamp() * 1000)
        self.d1 = D1()
        self.tasks = NativeTasks(labels=LABELS)
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        self.journal: list[str] = []
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

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def mail(self, event_id: str, task_id: str, *, received: int, summary: str = "", brief: str | None = None) -> None:
        self.d1.db.execute(
            "INSERT INTO mail_events (source_id, event_id, payload_hash, state, task_id, created_at, updated_at)"
            " VALUES ('mail-hero-personal', ?, ?, 'complete', ?, ?, ?)",
            (event_id, "0" * 64, task_id, received, received),
        )
        self.d1.db.execute(
            "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id, brief)"
            " VALUES (?, ?, 'Synthetic subject', ?, 'm', ?, ?)",
            (event_id, received + 30, summary, task_id, brief),
        )
        if task_id:
            self.tasks.add(task_id)

    def receipts(self) -> list[tuple[Any, ...]]:
        return [tuple(row) for row in self.sql.db.execute("SELECT method, state, commands, result FROM plus_receipts")]


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts

        yield Stack(
            types.SimpleNamespace(plus_api=plus_api, plus_receipts=plus_receipts, clock=stubs["clock"]), monkeypatch
        )


AT = int(NOW.timestamp())
E1, E2, E3 = (str(uuid.UUID(int=index)) for index in (1, 2, 3))


# ---- reads ----------------------------------------------------------------------------------------------------


def test_mail_list_pages_pending_summaries_without_tasks_or_full_text(stack):
    ids = [str(uuid.UUID(int=index + 100)) for index in range(53)]
    for event_id in ids:
        stack.mail(event_id, "", received=AT, summary="Synthetic brief.\n" + "private synthetic detail " * 100)
    stack.d1.db.execute("UPDATE summaries SET triaged_at=1 WHERE event_id=?", (ids[0],))
    stack.d1.db.execute("UPDATE summaries SET imported=1 WHERE event_id=?", (ids[1],))
    stack.tasks.calls.clear()
    first = stack.call("ListMailItems", page_size=50)
    assert len(first["mail_items"]) == 50 and first["next_page_token"]
    second = stack.call("ListMailItems", page_size=50, page_token=first["next_page_token"])
    assert len(second["mail_items"]) == 1 and not second.get("next_page_token")
    items = first["mail_items"] + second["mail_items"]
    assert [item["id"] for item in items] == sorted(ids[2:], reverse=True)
    assert all(item["title"] == "Synthetic subject" and item["etag"] for item in items)
    assert all("task" not in item and "summary" not in item for item in items)
    assert items[0]["brief"] == "Synthetic brief."
    assert stack.tasks.calls == []
    for request in ({"page_size": 51}, {"page_token": "garbage"}):
        assert stack.call("ListMailItems", **request) == {"error": "BAD_REQUEST"}


def test_mail_summary_deletion_keeps_existing_tasks_and_event_dedup(stack):
    stack.mail(E1, "linked", received=AT, summary="Synthetic summary")
    stack.mail(E2, "filed", received=AT, summary="Already triaged")
    stack.d1.db.execute("UPDATE summaries SET triaged_at=1 WHERE event_id=?", (E2,))
    request = {"event_ids": [E1, E2, E3], "request_id": str(uuid.uuid4())}
    answer = stack.call("DeleteMailSummaries", **request)
    assert answer == {"deleted_event_ids": [E1, E3], "kept_event_ids": [E2]}
    assert stack.call("DeleteMailSummaries", **request) == answer
    assert set(stack.tasks.tasks) == {"linked", "filed"}
    assert {row[0] for row in stack.d1.db.execute("SELECT event_id FROM mail_events")} == {E1, E2}
    assert [row[0] for row in stack.d1.db.execute("SELECT event_id FROM summaries")] == [E2]
    assert stack.tasks.calls == []


def test_mail_delete_receipt_handles_200_retained_entries(stack):
    ids = [str(uuid.UUID(int=index + 100)) for index in range(200)]
    for event_id in ids:
        stack.mail(event_id, "", received=AT)
    stack.d1.db.execute("UPDATE summaries SET triaged_at=1")
    request = {"event_ids": ids, "request_id": str(uuid.uuid4())}
    assert stack.call("DeleteMailSummaries", **request) == {"kept_event_ids": ids}
    assert stack.call("DeleteMailSummaries", **request) == {"kept_event_ids": ids}
    result = stack.sql.db.execute("SELECT result FROM plus_receipts").fetchone()[0]
    assert len(result) < 4096


def test_read_summary_answers_the_full_text_or_nothing(stack):
    stack.mail(E1, "t1", received=AT, summary="第一句。\n\n**要点**\n- a\n- b")
    assert stack.call("ReadMailSummary", id=E1) == {"summary": "第一句。\n\n**要点**\n- a\n- b"}
    assert stack.call("ReadMailSummary", id=E2) == {}
    assert stack.tasks.calls == []


def test_categories_accept_an_ordinary_active_tag_without_a_destination(stack):
    original = stack.call("ReadMailSettings")
    saved = stack.call(
        "UpdateMailCategories",
        categories=[{"label": {"provider": "tasks", "external_id": "id-active"}, "priority": "p2"}],
        etag=original["etag"],
    )
    assert saved["categories"][0]["label"] == {"provider": "tasks", "external_id": "id-active"}
    assert "destination" not in saved
    assert "destination" not in stack.call("ReadMailSettings")


def test_mail_writes_stop_in_maintenance_while_reads_go_on(stack):
    stack.mail(E1, "", received=AT, summary="Synthetic summary")
    stack.core.env.MAINTENANCE_MODE = "true"
    request = {"event_ids": [E1], "request_id": str(uuid.uuid4())}
    assert stack.call("DeleteMailSummaries", **request) == {"error": "MAINTENANCE"}
    etag = stack.call("ReadMailSettings")["etag"]
    assert stack.call("UpdateMailCategories", categories=[], etag=etag) == {"error": "MAINTENANCE"}
    assert [item["id"] for item in stack.call("ListMailItems")["mail_items"]] == [E1]
    assert stack.call("ReadMailSummary", id=E1) == {"summary": "Synthetic summary"}


def test_no_mail_text_reaches_the_logs_or_the_receipts(stack, capsys):
    stack.mail(E1, "", received=AT, summary="合成机密简介不应出现在日志里。\n\n合成机密正文。")
    stack.mail(E2, "", received=AT - 1, summary="另一封合成邮件。", brief="合成机密模型简介。")
    assert stack.call("ListMailItems")["mail_items"]
    assert stack.call("ReadMailSummary", id=E1)["summary"]
    request = {"event_ids": [E2], "request_id": str(uuid.uuid4())}
    assert stack.call("DeleteMailSummaries", **request) == {"deleted_event_ids": [E2]}
    logged = capsys.readouterr().out
    receipts = json.dumps(stack.receipts(), ensure_ascii=False)
    for text in ("合成机密", "Synthetic subject", "另一封"):
        assert text not in logged and text not in receipts
