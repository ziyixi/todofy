"""The Mail entry (runtime/mail.py, todofy.mail.v1) on host CPython: D1 is host SQLite with every migration
(host_support.py). Todofy reads and marks the mail it keeps and calls no task store. Synthetic mail only."""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.host_support import D1, ObjectSql, stubbed_pyodide

NOW = int(datetime(2026, 10, 21, 16, tzinfo=UTC).timestamp())
DAY = 86_400
E1, E2, E3 = (str(uuid.UUID(int=index)) for index in (1, 2, 3))


class Stack:
    def __init__(self, runtime: Any, clock: dict[str, int], failure: type[Exception]) -> None:
        self.runtime = runtime
        clock["ms"] = NOW * 1000
        self.d1 = D1()
        self.failure = failure
        self.core = types.SimpleNamespace(env=types.SimpleNamespace(DB=self.d1), sql=ObjectSql())

    def answer(self, method: str, request: Any) -> dict[str, Any]:
        text = request if isinstance(request, str) else json.dumps(request)
        return asyncio.run(self.runtime.handle(self.core, method, text))

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = self.answer(method, request)
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def mail(self, event_id: str, *, received: int = NOW - 3600, summary: str = "Synthetic summary.", **columns: Any):
        """A summarised mail: its ledger event, received at ``received``, and its summaries row 30 s later."""
        self.d1.db.execute(
            "INSERT INTO mail_events (source_id, event_id, payload_hash, state, created_at, updated_at)"
            " VALUES ('mail-hero-personal', ?, ?, 'complete', ?, ?)",
            (event_id, "0" * 64, received, received),
        )
        row = {"event_id": event_id, "created_at": received + 30, "subject": "Synthetic subject", "summary": summary}
        row |= {"model": "m", **columns}
        self.d1.db.execute(
            f"INSERT INTO summaries ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values())
        )

    def row(self, event_id: str) -> dict[str, Any] | None:
        found = self.d1.db.execute(
            "SELECT task_id, triaged_at, category_id FROM summaries WHERE event_id = ?", (event_id,)
        ).fetchone()
        return None if found is None else dict(found)


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import mail

        yield Stack(mail, stubs["clock"], stubs["JsException"])


# ---- reads ----------------------------------------------------------------------------------------------------


def test_the_list_pages_pending_mail_newest_first_without_summaries(stack):
    ids = [str(uuid.UUID(int=index + 100)) for index in range(53)]
    for event_id in ids:
        stack.mail(event_id, summary="Synthetic brief.\n" + "private synthetic detail " * 100)
    stack.d1.db.execute("UPDATE summaries SET triaged_at = 1, task_id = 'converted' WHERE event_id = ?", (ids[0],))
    stack.d1.db.execute("UPDATE summaries SET imported = 1 WHERE event_id = ?", (ids[1],))
    first = stack.call("ListMailItems", page_size=50)
    assert len(first["mail_items"]) == 50 and first["next_page_token"]
    second = stack.call("ListMailItems", page_size=50, page_token=first["next_page_token"])
    assert len(second["mail_items"]) == 1 and "next_page_token" not in second
    items = first["mail_items"] + second["mail_items"]
    assert [item["id"] for item in items] == sorted(ids[2:], reverse=True)
    item = items[0]
    assert item["name"] == f"mailItems/{item['id']}" and item["title"] == "Synthetic subject"
    assert (item["brief"], item["has_summary"], item["pending"]) == ("Synthetic brief.", True, True)
    assert item["receive_time"] == "2026-10-21T15:00:00Z" and len(item["etag"]) == 64
    assert all("summary" not in item and "task_id" not in item for item in items)
    assert len(stack.call("ListMailItems")["mail_items"]) == 25
    for request in ({"page_size": 51}, {"page_size": -1}, {"page_token": "garbage"}):
        assert stack.call("ListMailItems", **request) == {"error": "BAD_REQUEST"}


def test_an_adopted_older_mail_lists_its_task(stack):
    stack.mail(E1, task_id="older-task")
    [item] = stack.call("ListMailItems")["mail_items"]
    assert (item["task_id"], item["pending"]) == ("older-task", True)


def test_a_mail_is_read_whole_pending_or_not(stack):
    stack.mail(E1, summary="第一句。\n\n**要点**\n- a\n- b", subject="")
    item = stack.call("GetMailItem", name=f"mailItems/{E1}")
    assert (item["title"], item["summary"], item["pending"]) == ("(No subject)", "第一句。\n\n**要点**\n- a\n- b", True)
    stack.d1.db.execute("UPDATE summaries SET triaged_at = 5, task_id = 't1' WHERE event_id = ?", (E1,))
    converted = stack.call("GetMailItem", name=f"mailItems/{E1}")
    assert (converted["task_id"], converted.get("pending", False)) == ("t1", False)
    assert stack.call("GetMailItem", name=f"mailItems/{E2}") == {"error": "NOT_FOUND"}
    for name in ("mailItems/tmp-browser", "mailEvents/" + E1, "mailItems/a b"):
        assert stack.call("GetMailItem", name=name) == {"error": "BAD_REQUEST"}


def test_a_summary_is_answered_within_64_kib_on_a_character_boundary(stack):
    stack.mail(E1, summary="长" * 30_000)
    summary = stack.call("GetMailItem", name=f"mailItems/{E1}")["summary"]
    assert len(summary.encode()) <= 64 << 10 and set(summary) == {"长"}


def test_the_inbox_counts_pending_mail_and_its_carryover(stack):
    stack.mail(E1, received=NOW - 3600)
    stack.mail(E2, received=NOW - 3 * DAY)
    stack.mail(E3, received=NOW - 20 * DAY)
    stack.mail("converted", received=NOW - 2 * DAY, task_id="t", triaged_at=NOW)
    assert stack.call("GetMailInbox", name="mailInbox") == {
        "name": "mailInbox",
        "pending_count": 3,
        "carryover_count": 1,
    }
    assert stack.call("GetMailInbox", name="mailInboxes") == {"error": "BAD_REQUEST"}


# ---- readiness ------------------------------------------------------------------------------------------------


def transition(stack, event_id, state="complete", *, summary=True, imported=0, triaged_at=None):
    stack.d1.db.execute(
        "INSERT INTO event_transitions(event_id,at,to_state,actor) VALUES(?,1,?,'worker')", (event_id, state)
    )
    if summary:
        stack.d1.db.execute(
            "INSERT INTO summaries(event_id,created_at,subject,summary,model,imported,triaged_at)"
            " VALUES(?,123,'Synthetic private subject','Synthetic private body','m',?,?)",
            (event_id, imported, triaged_at),
        )


def test_readiness_starts_at_the_head_and_moves_past_every_transition(stack):
    assert stack.call("PollMailReady", baseline=True) == {"cursor": "0"}
    transition(stack, "arrived", state="pending", summary=False)
    transition(stack, "imported", imported=1)
    transition(stack, "converted", triaged_at=1)
    assert stack.call("PollMailReady", baseline=True) == {"cursor": "3"}
    transition(stack, "native")
    response = stack.call("PollMailReady", cursor="3")
    assert response == {"cursor": "4", "mail_items": [{"event_id": "native", "ready_time": "1970-01-01T00:02:03Z"}]}
    assert "Synthetic private" not in json.dumps(response)
    assert stack.call("PollMailReady", cursor="4") == {"cursor": "4"}


def test_a_poll_reads_at_most_50_transitions(stack):
    for index in range(51):
        transition(stack, f"unready-{index}", state="pending", summary=False)
    transition(stack, "ready")
    assert stack.call("PollMailReady", cursor="0") == {"cursor": "50"}
    assert [item["event_id"] for item in stack.call("PollMailReady", cursor="50")["mail_items"]] == ["ready"]


@pytest.mark.parametrize(
    "request_",
    [{}, {"cursor": "-1"}, {"cursor": "01"}, {"cursor": "9223372036854775808"}, {"baseline": True, "cursor": "0"}],
)
def test_an_invalid_poll_is_refused_before_any_read(stack, request_):
    assert stack.call("PollMailReady", **request_) == {"error": "BAD_REQUEST"}
    assert stack.d1.statements == []


def test_a_cursor_ahead_of_a_restored_database_needs_a_new_baseline(stack):
    transition(stack, "before-restore")
    assert stack.call("PollMailReady", baseline=True) == {"cursor": "1"}
    stack.d1.db.execute("DELETE FROM event_transitions")
    assert stack.call("PollMailReady", cursor="1") == {"error": "CURSOR_RESET_REQUIRED"}


# ---- writes ---------------------------------------------------------------------------------------------------


def test_marking_a_mail_converted_links_its_task_once(stack):
    stack.mail(E1)
    [listed] = stack.call("ListMailItems")["mail_items"]
    name = f"mailItems/{E1}"
    assert stack.call("MarkMailConverted", name=name, etag="stale", task_id="t1") == {"error": "ETAG_MISMATCH"}
    assert stack.row(E1) == {"task_id": "", "triaged_at": None, "category_id": None}
    marked = stack.call("MarkMailConverted", name=name, etag=listed["etag"], task_id="t1", category_id="3")
    assert (marked["task_id"], marked.get("pending", False), "summary" in marked) == ("t1", False, False)
    assert stack.row(E1) == {"task_id": "t1", "triaged_at": NOW, "category_id": 3}
    assert stack.call("ListMailItems") == {}
    # A repeat (a lost answer) with the same etag and task answers the mail as it is.
    assert stack.call("MarkMailConverted", name=name, etag=listed["etag"], task_id="t1") == marked
    assert stack.call("MarkMailConverted", name=name, etag=marked["etag"], task_id="t1") == marked
    assert stack.call("MarkMailConverted", name=name, etag=listed["etag"], task_id="t2") == {"error": "NOT_PENDING"}
    assert stack.row(E1) == {"task_id": "t1", "triaged_at": NOW, "category_id": 3}


def test_an_adopted_older_mail_takes_the_task_it_was_converted_to(stack):
    stack.mail(E1, task_id="older-task")
    [listed] = stack.call("ListMailItems")["mail_items"]
    marked = stack.call("MarkMailConverted", name=f"mailItems/{E1}", etag=listed["etag"], task_id="new-task")
    assert marked["task_id"] == "new-task" and stack.row(E1)["task_id"] == "new-task"


def test_a_mail_changed_between_the_read_and_the_write_is_not_marked(stack, monkeypatch):
    stack.mail(E1)
    [listed] = stack.call("ListMailItems")["mail_items"]
    real = stack.runtime._row

    async def read_then_change(core, event_id):
        row = await real(core, event_id)
        stack.d1.db.execute("UPDATE summaries SET task_id = 'elsewhere' WHERE event_id = ?", (event_id,))
        return row

    monkeypatch.setattr(stack.runtime, "_row", read_then_change)
    request = {"name": f"mailItems/{E1}", "etag": listed["etag"], "task_id": "t1"}
    assert stack.call("MarkMailConverted", **request) == {"error": "ETAG_MISMATCH"}
    assert stack.row(E1) == {"task_id": "elsewhere", "triaged_at": None, "category_id": None}


@pytest.mark.parametrize(
    "request_",
    [
        {"name": f"mailItems/{E1}", "etag": "", "task_id": "t1"},
        {"name": f"mailItems/{E1}", "etag": "x", "task_id": ""},
        {"name": f"mailItems/{E1}", "etag": "x", "task_id": "tmp-local"},
        {"name": f"mailItems/{E1}", "etag": "x", "task_id": "t1", "category_id": "0"},
        {"name": f"mailItems/{E1}", "etag": "x", "task_id": "t1", "category_id": "personal"},
        {"name": f"mailItems/{E1}", "etag": "x", "task_id": "t1", "request_id": str(uuid.uuid4())},
    ],
)
def test_a_mark_breaking_a_rule_is_refused(stack, request_):
    stack.mail(E1)
    assert stack.call("MarkMailConverted", **request_) == {"error": "BAD_REQUEST"}
    assert stack.row(E1)["triaged_at"] is None


def test_marking_an_unknown_mail_is_not_found(stack):
    assert stack.call("MarkMailConverted", name=f"mailItems/{E1}", etag="x", task_id="t1") == {"error": "NOT_FOUND"}


def test_deleting_summaries_keeps_converted_mail_and_the_ledger(stack):
    stack.mail(E1)
    stack.mail(E2, task_id="filed", triaged_at=1)
    request = {"event_ids": [E1, E2, E3]}
    answer = stack.call("DeleteMailSummaries", **request)
    assert answer == {"deleted_event_ids": [E1, E3], "kept_event_ids": [E2]}
    assert stack.call("DeleteMailSummaries", **request) == answer
    assert {row[0] for row in stack.d1.db.execute("SELECT event_id FROM mail_events")} == {E1, E2}
    assert [row[0] for row in stack.d1.db.execute("SELECT event_id FROM summaries")] == [E2]


@pytest.mark.parametrize("ids", [[], [E1, E1], [str(uuid.UUID(int=index)) for index in range(201)], ["tmp-x"]])
def test_a_deletion_out_of_bounds_is_refused(stack, ids):
    assert stack.call("DeleteMailSummaries", event_ids=ids) == {"error": "BAD_REQUEST"}


def test_writes_wait_in_maintenance_and_while_the_backup_holds_the_ledger(stack, monkeypatch):
    stack.mail(E1)
    [listed] = stack.call("ListMailItems")["mail_items"]
    mark = {"name": f"mailItems/{E1}", "etag": listed["etag"], "task_id": "t1"}
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.answer("MarkMailConverted", mark) == {"error": "MAINTENANCE", "retry_after": 300}
    assert stack.answer("DeleteMailSummaries", {"event_ids": [E1]}) == {"error": "MAINTENANCE", "retry_after": 300}
    assert [item["id"] for item in stack.call("ListMailItems")["mail_items"]] == [E1]
    stack.core.env.MAINTENANCE_MODE = "false"
    monkeypatch.setattr(stack.runtime.backup, "holds_ledger", lambda *_: True)
    assert stack.answer("MarkMailConverted", mark) == {"error": "UNAVAILABLE", "retry_after": 30}
    assert stack.call("GetMailItem", name=f"mailItems/{E1}")["pending"] is True
    assert stack.row(E1)["triaged_at"] is None


# ---- the envelope ---------------------------------------------------------------------------------------------


def test_every_request_is_read_strictly_and_an_unknown_rpc_is_not_found(stack):
    assert stack.answer("ListMailItems", "not json") == {"error": "BAD_REQUEST", "retry_after": None}
    assert stack.call("ListMailItems", unknown=True) == {"error": "BAD_REQUEST"}
    assert stack.call("ConvertMailItem") == {"error": "NOT_FOUND"}
    assert stack.call("ListMailItems") == {}


def test_a_d1_failure_is_unavailable_and_a_bug_internal(stack, monkeypatch, capsys):
    stack.d1.failing = stack.failure
    assert stack.answer("ListMailItems", {}) == {"error": "UNAVAILABLE", "retry_after": 30}
    stack.d1.failing = None
    monkeypatch.setattr(stack.runtime, "_inbox", None)
    monkeypatch.setitem(stack.runtime.METHODS, "GetMailInbox", (stack.runtime.pb.GetMailInboxRequest, None))
    assert stack.call("GetMailInbox", name="mailInbox") == {"error": "INTERNAL"}
    assert json.loads(capsys.readouterr().out) == {"mail": "internal", "rpc": "GetMailInbox", "error": "TypeError"}


def test_no_mail_text_reaches_the_logs(stack, capsys):
    stack.mail(E1, summary="合成机密简介不应出现在日志里。\n\n合成机密正文。")
    [listed] = stack.call("ListMailItems")["mail_items"]
    assert stack.call("GetMailItem", name=f"mailItems/{E1}")["summary"]
    assert stack.call("MarkMailConverted", name=f"mailItems/{E1}", etag=listed["etag"], task_id="t1")
    assert stack.call("DeleteMailSummaries", event_ids=[E1]) == {"kept_event_ids": [E1]}
    logged = capsys.readouterr().out
    assert "合成机密" not in logged and "Synthetic subject" not in logged
