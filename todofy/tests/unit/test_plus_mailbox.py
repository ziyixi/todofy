"""The Mailbox's RPCs through runtime/plus_api.handle on host CPython: LookupMailItems, ReadMailSummary,
Read/UpdateMailSettings, FileMailItem and DeleteMailItems.

D1 is host SQLite with every migration and the object's SQLite another (plus_support.py); Todoist is a fake that
keeps tasks, projects and command UUIDs and journals every call. The same RPCs in workerd, through the gateway, are
tests/runtime/test_plus_mailbox.py. Synthetic mail and tasks only.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.plus_support import D1, Storage, stubbed_pyodide
from todofy.core.mailbox import MailSettings

LABELS = ("office", "home", "committed", "focus", "candiate", "quarter", "lead_1d", "lead_3d", "lead_1w", "lead_2w")
LABELS += ("lead_1m", "quick", "deep", "active")
INBOX = "mail"
NOW = datetime(2026, 10, 16, 16, 0, tzinfo=UTC)


class Todoist:
    """Tasks, projects and labels; Sync applies item_update, item_move and item_delete once per UUID."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.labels = [{"id": "id-" + name, "name": name} for name in LABELS]
        self.tasks: dict[str, dict[str, Any]] = {}
        self.project_rows = [
            {"id": "inbox-p", "name": "Inbox", "inbox_project": True},
            {"id": INBOX, "name": "Email Inbox"},
            {"id": "work-p", "name": "Work"},
            {"id": "old-p", "name": "Old", "is_archived": True},
        ]
        self.applied: set[str] = set()
        self.lose_answer = False  # the next Sync applies its commands, then fails

    def add(self, task_id: str, **fields: Any) -> None:
        self.tasks[task_id] = {
            "id": task_id,
            "content": "Synthetic mail " + task_id,
            "project_id": INBOX,
            "labels": [],
            "priority": 1,
            "parent_id": None,
            "due": None,
            "deadline": None,
            "duration": None,
            "note_count": 0,
            **fields,
        }

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        self.calls.append("metadata:fresh" if fresh else "metadata")
        return {"timezone": "UTC", "labels": deepcopy(self.labels), "filters": []}

    async def task(self, _core: Any, task_id: str) -> dict[str, Any]:
        self.calls.append("task")
        if task_id not in self.tasks:
            raise self.error("NOT_FOUND")
        return deepcopy(self.tasks[task_id])

    async def list_tasks(self, _core: Any, limit: int = 200, cursor: str = "", **filters: str):
        self.calls.append("tasks:" + ",".join(sorted(filters)))
        found = list(self.tasks.values())
        if "project_id" in filters:
            found = [task for task in found if task["project_id"] == filters["project_id"]]
        if "ids" in filters:
            found = [task for task in found if task["id"] in filters["ids"].split(",")]
        start = int(cursor or 0)
        return deepcopy(found[start : start + limit]), str(start + limit) if start + limit < len(found) else ""

    async def projects(self, _core: Any) -> list[dict[str, Any]]:
        self.calls.append("projects")
        return deepcopy(self.project_rows)

    async def commands(self, _core: Any, commands: list[dict[str, Any]], *, gone_ok: bool = False):
        self.calls.append(f"sync:{len(commands)}")
        status: dict[str, Any] = {}
        for command in commands:
            args = command["args"]
            if command["uuid"] not in self.applied:
                if args["id"] not in self.tasks:
                    status[command["uuid"]] = {"error_tag": "ITEM_NOT_FOUND", "http_code": 404}
                    continue
                if command["type"] == "item_update":
                    self.tasks[args["id"]].update({key: value for key, value in args.items() if key != "id"})
                elif command["type"] == "item_move":
                    self.tasks[args["id"]]["project_id"] = args["project_id"]
                elif command["type"] == "item_delete":
                    del self.tasks[args["id"]]
                else:
                    raise AssertionError(command["type"])
                self.applied.add(command["uuid"])
            status[command["uuid"]] = "ok"
        if self.lose_answer:
            self.lose_answer = False
            raise self.error("UNAVAILABLE")
        done = [
            answer == "ok" or (gone_ok and isinstance(answer, dict) and answer["error_tag"] == "ITEM_NOT_FOUND")
            for answer in status.values()
        ]
        if not all(done):
            raise self.error("ACTION_NOT_ALLOWED")
        return {"sync_status": status}

    error: Any = None


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        runtime.clock["ms"] = int(NOW.timestamp() * 1000)
        self.d1 = D1()
        self.todoist = Todoist()
        Todoist.error = runtime.todoist.PlusError
        for name in ("metadata", "task", "projects", "commands"):
            monkeypatch.setattr(runtime.todoist, name, getattr(self.todoist, name))
        monkeypatch.setattr(runtime.todoist, "tasks", self.todoist.list_tasks)
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _tz: NOW.date().isoformat())
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        self.journal: list[str] = []
        storage = Storage(self.journal)
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.sql = storage.sql
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TODOIST_DEFAULT_PROJECT_ID=INBOX),
            plus_lock=asyncio.Lock(),
            todoist_wait=lambda _now: None,
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request), owner=True))
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
        self.todoist.add(task_id)

    def settings(self, *categories: tuple[str, str], destination: str = "inbox") -> dict[str, Any]:
        """UpdateMailSettings from the etag a lookup answers (D1 alone)."""
        etag = self.call("LookupMailItems", task_ids=[])["categories_etag"]
        return self.call(
            "UpdateMailSettings",
            categories=[
                {"label": {"provider": "todoist", "external_id": "id-" + label}, "priority": priority}
                for label, priority in categories
            ],
            destination={"provider": "todoist", "external_id": destination},
            etag=etag,
        )

    def task(self, task_id: str) -> dict[str, Any]:
        tasks = self.call("ListPlanningTasks", page_size=200)["planning_tasks"]
        return next(task for task in tasks if task["id"] == task_id)

    def receipts(self) -> list[tuple[Any, ...]]:
        return [tuple(row) for row in self.sql.db.execute("SELECT method, state, commands, result FROM plus_receipts")]


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts
        from todofy.runtime import plus_todoist as todoist

        stack = Stack(
            types.SimpleNamespace(
                plus_api=plus_api, plus_receipts=plus_receipts, todoist=todoist, clock=stubs["clock"]
            ),
            monkeypatch,
        )
        etag = stack.call("ReadPlan")["plan"]["etag"]
        assert "plan" in stack.call("ConfirmPlanMapping", etag=etag, request_id=str(uuid.uuid4()))
        stack.todoist.calls.clear()
        yield stack


AT = int(NOW.timestamp())
E1, E2, E3 = (str(uuid.UUID(int=index)) for index in (1, 2, 3))


# ---- reads ----------------------------------------------------------------------------------------------------


def test_native_mail_list_pages_pending_summaries_without_tasks_or_full_text(stack):
    stack.core.env.TASK_SOURCE = "tasks"
    ids = [str(uuid.UUID(int=index + 100)) for index in range(53)]
    for event_id in ids:
        stack.mail(event_id, "", received=AT, summary="Synthetic brief.\n" + "private synthetic detail " * 100)
    stack.d1.db.execute("UPDATE summaries SET triaged_at=1 WHERE event_id=?", (ids[0],))
    stack.d1.db.execute("UPDATE summaries SET imported=1 WHERE event_id=?", (ids[1],))
    stack.todoist.calls.clear()
    first = stack.call("ListMailItems", page_size=50)
    assert len(first["mail_items"]) == 50 and first["next_page_token"]
    second = stack.call("ListMailItems", page_size=50, page_token=first["next_page_token"])
    assert len(second["mail_items"]) == 1 and not second.get("next_page_token")
    items = first["mail_items"] + second["mail_items"]
    assert [item["id"] for item in items] == sorted(ids[2:], reverse=True)
    assert all(item["title"] == "Synthetic subject" and item["etag"] for item in items)
    assert all("task" not in item and "summary" not in item for item in items)
    assert items[0]["brief"] == "Synthetic brief."
    assert stack.todoist.calls == []
    for request in ({"page_size": 51}, {"page_token": "garbage"}):
        assert stack.call("ListMailItems", **request) == {"error": "BAD_REQUEST"}


def test_native_mail_summary_deletion_keeps_existing_tasks_and_event_dedup(stack):
    stack.core.env.TASK_SOURCE = "tasks"
    stack.mail(E1, "linked", received=AT, summary="Synthetic summary")
    stack.mail(E2, "filed", received=AT, summary="Already triaged")
    stack.d1.db.execute("UPDATE summaries SET triaged_at=1 WHERE event_id=?", (E2,))
    request = {"event_ids": [E1, E2, E3], "request_id": str(uuid.uuid4())}
    answer = stack.call("DeleteMailSummaries", **request)
    assert answer == {"deleted_event_ids": [E1, E3], "kept_event_ids": [E2]}
    assert stack.call("DeleteMailSummaries", **request) == answer
    assert set(stack.todoist.tasks) == {"linked", "filed"}
    assert {row[0] for row in stack.d1.db.execute("SELECT event_id FROM mail_events")} == {E1, E2}
    assert [row[0] for row in stack.d1.db.execute("SELECT event_id FROM summaries")] == [E2]
    assert stack.todoist.calls == []


def test_native_mail_delete_receipt_handles_200_retained_entries(stack):
    stack.core.env.TASK_SOURCE = "tasks"
    ids = [str(uuid.UUID(int=index + 100)) for index in range(200)]
    for event_id in ids:
        stack.mail(event_id, "", received=AT)
    stack.d1.db.execute("UPDATE summaries SET triaged_at=1")
    request = {"event_ids": ids, "request_id": str(uuid.uuid4())}
    assert stack.call("DeleteMailSummaries", **request) == {"kept_event_ids": ids}
    assert stack.call("DeleteMailSummaries", **request) == {"kept_event_ids": ids}
    result = stack.sql.db.execute("SELECT result FROM plus_receipts").fetchone()[0]
    assert len(result) < 4096


def test_lookup_answers_only_mail_with_its_brief_and_time_from_d1_alone(stack):
    stack.mail(E1, "t1", received=AT - 3600, summary="云服务账单已出，无需操作。\n\n详情……")
    stack.mail(E2, "t2", received=AT - 60, summary="旧摘要第一句。第二句。", brief="模型写的简介。")
    stack.mail(E3, "t3", received=AT - 7200, summary="")
    stack.todoist.add("own")  # a task the owner made in the mail project: no ledger row
    answer = stack.call("LookupMailItems", task_ids=["t1", "t2", "t3", "own", "unknown"])
    items = {item["task"]["external_id"]: item for item in answer["items"]}
    assert set(items) == {"t1", "t2", "t3"}
    assert items["t1"] == {
        "id": E1,
        "task": {"provider": "todoist", "external_id": "t1"},
        "brief": "云服务账单已出，无需操作。",
        "receive_time": "2026-10-16T15:00:00Z",
        "has_summary": True,
    }
    assert items["t2"]["brief"] == "模型写的简介。"  # a stored brief wins over the first sentence
    assert "brief" not in items["t3"] and "has_summary" not in items["t3"]  # the wire omits "" and false
    assert answer["categories_etag"] and "categories" not in answer and "destination" not in answer
    assert stack.todoist.calls == []
    assert stack.call("LookupMailItems", task_ids=["t1"] * 2) == {"error": "BAD_REQUEST"}
    assert stack.call("LookupMailItems", task_ids=[f"t{index}" for index in range(201)]) == {"error": "BAD_REQUEST"}


def test_read_summary_answers_the_full_text_or_nothing(stack):
    stack.mail(E1, "t1", received=AT, summary="第一句。\n\n**要点**\n- a\n- b")
    assert stack.call("ReadMailSummary", id=E1) == {"summary": "第一句。\n\n**要点**\n- a\n- b"}
    assert stack.call("ReadMailSummary", id=E2) == {}
    assert stack.todoist.calls == []


def test_settings_answer_the_account_inbox_for_extensions_before_protocol_6(stack):
    """Their categories dialog asks for a destination: the Inbox is the only one, so it can still save."""
    inbox = {"provider": "todoist", "external_id": "inbox-p"}
    answer = stack.call("ReadMailSettings")
    assert answer["destination"] == inbox
    assert answer["projects"] == [{"id": "inbox-p", "display_name": "Inbox", "inbox": True}]
    assert stack.todoist.calls == ["projects"] and "categories" not in answer
    # A destination an older extension saved is not answered here, and no Inbox answers none.
    save_destination(stack, "work-p")
    assert stack.call("ReadMailSettings")["destination"] == inbox
    stack.todoist.project_rows[0]["inbox_project"] = False
    assert stack.call("ReadMailSettings") == {"etag": stack.call("ReadMailSettings")["etag"]}
    # Nor when the mail project would be the Inbox (filing would move nothing).
    stack.todoist.project_rows[1]["inbox_project"] = True
    assert "destination" not in stack.call("ReadMailSettings")


def save_destination(stack: Stack, destination: str) -> None:
    """The binding with the destination an extension before protocol 6 saved."""
    row = stack.d1.db.execute("SELECT value FROM plan_settings WHERE key = 'todoist.mail'").fetchone()
    value = {**json.loads(row[0] if row else '{"categories": []}'), "destination": destination}
    stack.d1.db.execute("INSERT OR REPLACE INTO plan_settings VALUES ('todoist.mail', ?, 1)", (json.dumps(value),))
    stack.d1.db.commit()


# ---- UpdateMailSettings ---------------------------------------------------------------------------------------


def test_categories_are_saved_kept_by_label_and_priority_and_replayed_by_value(stack):
    saved = stack.settings(("office", "p2"), ("quick", "p4"))
    first = [category["id"] for category in saved["categories"]]
    # The destination is stored as sent, and never checked against Todoist.
    assert saved["destination"] == {"provider": "todoist", "external_id": "inbox"}
    assert "projects" not in stack.todoist.calls
    assert [
        row[1:]
        for row in stack.d1.db.execute("SELECT id, name, priority, sort_order, archived_at FROM plan_categories")
    ] == [
        ("office · P2", 2, 0, None),
        ("quick · P4", 4, 1, None),
    ]
    binding = json.loads(
        stack.d1.db.execute("SELECT value FROM plan_settings WHERE key = 'todoist.mail'").fetchone()[0]
    )
    assert binding["destination"] == "inbox" and [entry["label_id"] for entry in binding["categories"]] == [
        "id-office",
        "id-quick",
    ]
    # The same categories again, with any etag and any destination: the saved ones, no write.
    statements = len(stack.d1.statements)
    again = stack.call(
        "UpdateMailSettings",
        categories=[{"label": c["label"], "priority": c["priority"]} for c in saved["categories"]],
        destination={"provider": "todoist", "external_id": "work-p"},
        etag="stale",
    )
    assert again == saved and not any(s.startswith(("INSERT", "UPDATE")) for s in stack.d1.statements[statements:])
    # Reordered and one replaced: the kept one keeps its ID, the dropped one is archived.
    changed = stack.settings(("deep", "p3"), ("quick", "p4"))
    assert changed["categories"][1]["id"] == first[1] and changed["categories"][0]["id"] not in first
    assert stack.d1.db.execute("SELECT count(*) FROM plan_categories WHERE archived_at IS NOT NULL").fetchone()[0] == 1
    assert stack.call("LookupMailItems", task_ids=[])["categories"] == changed["categories"]
    ignored = {"provider": "todoist", "external_id": "inbox"}
    assert stack.call("UpdateMailSettings", categories=[], destination=ignored, etag=saved["etag"]) == {
        "error": "ETAG_MISMATCH"
    }
    # No category at all is a valid save.
    cleared = stack.call("UpdateMailSettings", categories=[], destination=ignored, etag=changed["etag"])
    assert "categories" not in cleared and cleared["etag"] == MailSettings((), "inbox").etag
    assert "projects" not in stack.todoist.calls


def test_a_sent_destination_is_stored_unchecked_in_place_of_one_saved_before(stack):
    """An extension before protocol 6 offers its categories only while a destination is saved: the account Inbox
    ReadMailSettings answered, which it sends, is stored as sent. So is any well-formed reference, even one that
    never existed: it is never checked against Todoist, and filing never reads it."""
    save_destination(stack, "work-p")
    before = stack.call("LookupMailItems", task_ids=[])["categories_etag"]
    stack.todoist.calls.clear()
    saved = stack.settings(("deep", "p3"), destination="no-such-project")
    assert saved["destination"] == {"provider": "todoist", "external_id": "no-such-project"}
    assert saved["etag"] != before
    # The same categories again are a replay, whatever the destination: nothing is written.
    assert stack.settings(("deep", "p3"), destination=INBOX) == saved
    changed = stack.settings(("deep", "p3"), ("quick", "p4"), destination="inbox-p")
    assert changed["destination"] == {"provider": "todoist", "external_id": "inbox-p"}
    assert stack.call("LookupMailItems", task_ids=[])["destination"] == changed["destination"]
    assert "projects" not in stack.todoist.calls
    binding = json.loads(
        stack.d1.db.execute("SELECT value FROM plan_settings WHERE key = 'todoist.mail'").fetchone()[0]
    )
    assert binding["destination"] == "inbox-p"
    current = stack.call("ReadMailSettings")
    malformed = {"provider": "linear", "external_id": "inbox"}
    assert stack.call("UpdateMailSettings", categories=[], destination=malformed, etag=current["etag"]) == {
        "error": "BAD_REQUEST"
    }


@pytest.mark.parametrize(
    ("categories", "destination", "error"),
    [
        pytest.param([("committed", "p1")], "work-p", "ACTION_NOT_ALLOWED", id="planning_label"),
        pytest.param([("lead_1w", "p1")], "work-p", "ACTION_NOT_ALLOWED", id="lead_label"),
        pytest.param([("active", "p1")], "work-p", "ACTION_NOT_ALLOWED", id="in_progress_label"),
        pytest.param([("gone", "p1")], "work-p", "ACTION_NOT_ALLOWED", id="no_such_label"),
        pytest.param([("deep", "p1"), ("deep", "p1")], "work-p", "BAD_REQUEST", id="twice"),
        pytest.param([("deep", "unspecified")], "work-p", "BAD_REQUEST", id="no_priority"),
        pytest.param([(f"x{index}", "p1") for index in range(5)], "work-p", "BAD_REQUEST", id="five"),
    ],
)
def test_settings_that_break_a_rule_write_nothing(stack, categories, destination, error):
    stack.todoist.labels += [{"id": f"id-x{index}", "name": f"x{index}"} for index in range(5)]
    assert stack.settings(*categories, destination=destination) == {"error": error}
    assert stack.d1.db.execute("SELECT count(*) FROM plan_categories").fetchone()[0] == 0


# ---- FileMailItem ---------------------------------------------------------------------------------------------


def filed(stack: Stack, task_id: str, category: dict[str, Any], etag: str, request_id: str | None = None):
    return stack.call(
        "FileMailItem",
        task_id=task_id,
        etag=stack.task(task_id)["etag"],
        category_id=category["id"],
        categories_etag=etag,
        request_id=request_id or str(uuid.uuid4()),
    )


def test_filing_is_one_sync_of_label_priority_and_move_under_a_receipt(stack):
    stack.mail(E1, "t1", received=AT)
    stack.todoist.tasks["t1"]["labels"] = ["home", "context"]
    saved = stack.settings(("office", "p2"))
    stack.todoist.calls.clear()
    request_id = str(uuid.uuid4())
    answer = filed(stack, "t1", saved["categories"][0], saved["etag"], request_id)
    task = stack.todoist.tasks["t1"]
    assert (task["labels"], task["priority"], task["project_id"]) == (["context", "office"], 3, "inbox-p")
    assert answer["task"]["project_id"] == "inbox-p" and answer["task"]["area"] == "work"
    # One label sync, the Inbox looked up, the task read, one Sync with both commands, the confirming read.
    assert stack.todoist.calls[-5:] == ["metadata:fresh", "projects", "task", "sync:2", "task"]
    assert stack.receipts() == [("FileMailItem", "done", None, '{"task_id":"t1"}')]
    assert stack.journal == ["storage.sync"]  # the receipt was durable before the Sync went out


def test_a_lost_answer_is_finished_by_the_same_request_and_runs_nothing_twice(stack):
    stack.mail(E1, "t1", received=AT)
    saved = stack.settings(("quick", "p4"))
    request = dict(
        task_id="t1",
        etag=stack.task("t1")["etag"],
        category_id=saved["categories"][0]["id"],
        categories_etag=saved["etag"],
        request_id=str(uuid.uuid4()),
    )
    stack.todoist.lose_answer = True
    assert stack.call("FileMailItem", **request) == {"error": "UNAVAILABLE"}
    assert stack.receipts()[0][1] == "started"
    # The task has left the mail project: the filing is done, and nothing is sent again.
    calls = len(stack.todoist.calls)
    answer = stack.call("FileMailItem", **request)
    assert answer["task"]["labels"] == ["quick"] and len(stack.todoist.applied) == 2
    assert stack.todoist.calls[calls:] == ["metadata:fresh", "task"]
    assert stack.receipts()[0][1] == "done"
    assert stack.call("FileMailItem", **request)["task"]["id"] == "t1"
    assert stack.call("FileMailItem", **{**request, "category_id": "999"}) == {"error": "BAD_REQUEST"}


def unreachable(stack: Stack):
    """A Sync that never reaches Todoist (a 429 or a network failure)."""

    async def commands(_core: Any, commands: list[dict[str, Any]], *, gone_ok: bool = False):
        stack.todoist.calls.append(f"unsent:{len(commands)}")
        raise stack.runtime.todoist.PlusError("UNAVAILABLE")

    return commands


def recorded(stack: Stack, sent: list[dict[str, Any]]):
    """The fake's Sync, recording every command it is sent."""

    async def commands(core: Any, commands: list[dict[str, Any]], *, gone_ok: bool = False):
        sent.extend(commands)
        return await stack.todoist.commands(core, commands, gone_ok=gone_ok)

    return commands


def a_filing(stack: Stack, category: tuple[str, str] = ("deep", "p1")) -> dict[str, Any]:
    stack.mail(E1, "t1", received=AT)
    saved = stack.settings(category)
    return dict(
        task_id="t1",
        etag=stack.task("t1")["etag"],
        category_id=saved["categories"][0]["id"],
        categories_etag=saved["etag"],
        request_id=str(uuid.uuid4()),
    )


def test_a_partial_filing_is_finished_by_the_same_request(stack, monkeypatch):
    request = a_filing(stack)
    real = stack.todoist.commands

    async def update_only(core: Any, commands: list[dict[str, Any]], *, gone_ok: bool = False):
        await real(core, commands[:1])
        raise stack.runtime.todoist.PlusError("ACTION_NOT_ALLOWED")  # Todoist refused the move

    monkeypatch.setattr(stack.runtime.todoist, "commands", update_only)
    assert stack.call("FileMailItem", **request) == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.todoist.tasks["t1"]["labels"] == ["deep"] and stack.todoist.tasks["t1"]["project_id"] == INBOX
    monkeypatch.setattr(stack.runtime.todoist, "commands", real)
    # The task as it is now (its own label already written) builds the frozen commands: they go again.
    answer = stack.call("FileMailItem", **request)
    assert answer["task"]["project_id"] == "inbox-p" and stack.todoist.tasks["t1"]["priority"] == 4
    assert len(stack.todoist.applied) == 2


@pytest.mark.parametrize("change", ["renamed", "added"])
def test_a_filing_retry_never_resends_labels_chosen_before_a_change(stack, monkeypatch, change):
    """Renamed: resending the frozen name would make Todoist create a label (Plus never does). Added: resending
    the frozen list would drop the owner's label."""
    request = a_filing(stack)
    monkeypatch.setattr(stack.runtime.todoist, "commands", unreachable(stack))
    assert stack.call("FileMailItem", **request) == {"error": "UNAVAILABLE"}
    if change == "renamed":
        next(label for label in stack.todoist.labels if label["name"] == "deep")["name"] = "deep-work"
    else:
        stack.todoist.tasks["t1"]["labels"] = ["context"]
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(stack.runtime.todoist, "commands", recorded(stack, sent))
    assert stack.call("FileMailItem", **request) == {"error": "ETAG_MISMATCH"}
    assert sent == [] and stack.todoist.tasks["t1"]["project_id"] == INBOX
    # The next click builds new commands under a new request ID, from what Todoist has now.
    task = stack.call("FileMailItem", **{**request, "etag": stack.task("t1")["etag"], "request_id": str(uuid.uuid4())})
    assert task["task"]["labels"] == (["deep-work"] if change == "renamed" else ["context", "deep"])


def test_filing_to_the_inbox_alone_is_one_move_without_a_label_sync(stack, monkeypatch):
    stack.mail(E1, "t1", received=AT)
    stack.todoist.tasks["t1"].update(labels=["context"], priority=2)
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(stack.runtime.todoist, "commands", recorded(stack, sent))
    request = dict(task_id="t1", etag=stack.task("t1")["etag"], category_id="", categories_etag="any")
    request["request_id"] = str(uuid.uuid4())
    stack.todoist.calls.clear()
    # No category is saved: the categories etag is not checked, and labels and priority stay.
    answer = stack.call("FileMailItem", **request)
    assert answer["task"]["project_id"] == "inbox-p" and answer["task"]["labels"] == ["context"]
    assert stack.todoist.tasks["t1"]["priority"] == 2
    move = {"id": "t1", "project_id": "inbox-p"}
    command_id = stack.runtime.todoist.plus.command_id(request["request_id"], 1)
    assert sent == [{"type": "item_move", "uuid": command_id, "args": move}]
    assert stack.todoist.calls == ["metadata", "projects", "task", "sync:1", "task"]  # the cached labels
    assert stack.receipts() == [("FileMailItem", "done", None, '{"task_id":"t1"}')]
    # Done: the same request reads the task alone.
    calls = len(stack.todoist.calls)
    assert stack.call("FileMailItem", **request)["task"]["project_id"] == "inbox-p"
    assert stack.todoist.calls[calls:] == ["metadata", "task"] and len(sent) == 1
    # A task changed since it was shown is still refused.
    stack.mail(E2, "t2", received=AT)
    stale = {**request, "task_id": "t2", "etag": "stale", "request_id": str(uuid.uuid4())}
    assert stack.call("FileMailItem", **stale) == {"error": "ETAG_MISMATCH"}


def test_a_lost_inbox_filing_is_finished_without_a_second_move(stack):
    stack.mail(E1, "t1", received=AT)
    request = dict(task_id="t1", etag=stack.task("t1")["etag"], category_id="", categories_etag="")
    request["request_id"] = str(uuid.uuid4())
    stack.todoist.lose_answer = True
    assert stack.call("FileMailItem", **request) == {"error": "UNAVAILABLE"}
    calls = len(stack.todoist.calls)
    assert stack.call("FileMailItem", **request)["task"]["project_id"] == "inbox-p"
    assert stack.todoist.calls[calls:] == ["metadata", "task"] and len(stack.todoist.applied) == 1


def test_filing_ignores_a_saved_destination_and_refuses_without_an_account_inbox(stack, monkeypatch):
    request = a_filing(stack)
    save_destination(stack, "work-p")  # what an older extension chose; the categories etag changes with it
    request["categories_etag"] = stack.call("LookupMailItems", task_ids=[])["categories_etag"]
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(stack.runtime.todoist, "commands", recorded(stack, sent))
    inbox = stack.todoist.project_rows[0]
    for missing in ({"inbox_project": False}, {"id": INBOX}):
        # Todoist lists no Inbox, or the mail project is the Inbox: nothing to move into.
        original = dict(inbox)
        inbox.update(missing)
        assert stack.call("FileMailItem", **request) == {"error": "ACTION_NOT_ALLOWED"}
        inbox.clear()
        inbox.update(original)
    assert sent == [] and stack.receipts() == []
    assert stack.call("FileMailItem", **request)["task"]["project_id"] == "inbox-p"
    assert [command["args"].get("project_id") for command in sent] == [None, "inbox-p"]


@pytest.mark.parametrize(
    ("change", "error"),
    [
        pytest.param({"categories_etag": "stale"}, "ETAG_MISMATCH", id="categories_changed"),
        pytest.param({"etag": "stale"}, "ETAG_MISMATCH", id="task_changed"),
        pytest.param({"category_id": "999"}, "BAD_REQUEST", id="no_such_category"),
    ],
)
def test_filing_refuses_what_the_owner_did_not_see(stack, change, error):
    stack.mail(E1, "t1", received=AT)
    saved = stack.settings(("quick", "p4"))
    request = dict(
        task_id="t1",
        etag=stack.task("t1")["etag"],
        category_id=saved["categories"][0]["id"],
        categories_etag=saved["etag"],
        request_id=str(uuid.uuid4()),
    )
    assert stack.call("FileMailItem", **{**request, **change}) == {"error": error}
    assert stack.todoist.applied == set()


def test_filing_refuses_a_moved_task_and_a_deleted_label(stack):
    stack.mail(E1, "t1", received=AT)
    stack.mail(E2, "t2", received=AT)
    saved = stack.settings(("deep", "p1"))
    stack.todoist.tasks["t1"]["project_id"] = "work-p"
    assert filed(stack, "t1", saved["categories"][0], saved["etag"]) == {"error": "ACTION_NOT_ALLOWED"}
    stack.todoist.labels = [label for label in stack.todoist.labels if label["name"] != "deep"]
    assert filed(stack, "t2", saved["categories"][0], saved["etag"]) == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.todoist.applied == set()


# ---- DeleteMailItems ------------------------------------------------------------------------------------------


def test_native_delete_protects_native_dependencies_without_adopting_legacy_same_id_links(stack):
    from todofy.runtime import plus_mail

    stack.core.env.TASK_SOURCE = "tasks"
    stack.d1.db.execute("INSERT INTO plan_settings VALUES ('native', '{\"initialized\":true}', 1)")
    for index, task_id in enumerate(("plain", "waiter", "prerequisite"), start=1):
        stack.mail(str(uuid.UUID(int=index)), task_id, received=AT)
    stack.d1.db.executemany(
        "INSERT INTO plan_tasks(id,provider,external_id,created_at) VALUES (?,?,?,1)",
        ((1, "tasks", "waiter"), (2, "tasks", "prerequisite"), (3, "todoist", "plain"), (4, "todoist", "legacy")),
    )
    stack.d1.db.executemany(
        "INSERT INTO plan_edges(task_id,prerequisite_id,created_at) VALUES (?,?,1)", ((1, 2), (4, 3))
    )
    deletable, absent, _ = asyncio.run(plus_mail._deletions(stack.core, ["plain", "waiter", "prerequisite"]))
    assert deletable == {"plain"}
    assert absent == set()


def test_native_categories_accept_an_ordinary_active_tag_without_a_destination(stack):
    stack.core.env.TASK_SOURCE = "tasks"
    assert stack.call("ReadPlan")["plan"].get("enabled", False) is False
    original = stack.call("ReadMailSettings")
    saved = stack.call(
        "UpdateMailCategories",
        categories=[{"label": {"provider": "tasks", "external_id": "id-active"}, "priority": "p2"}],
        etag=original["etag"],
    )
    assert saved["categories"][0]["label"] == {"provider": "tasks", "external_id": "id-active"}
    assert "destination" not in saved
    assert "destination" not in stack.call("ReadMailSettings")


def test_legacy_mail_requests_retain_their_published_required_fields(stack):
    filing = {
        "task_id": "synthetic",
        "etag": "shown",
        "category_id": "",
        "categories_etag": "",
        "request_id": str(uuid.uuid4()),
    }
    for field in ("task_id", "category_id", "categories_etag"):
        assert stack.call("FileMailItem", **{key: value for key, value in filing.items() if key != field}) == {
            "error": "BAD_REQUEST"
        }
    assert stack.call("DeleteMailItems", request_id=str(uuid.uuid4())) == {"error": "BAD_REQUEST"}
    assert stack.call("UpdateMailSettings", categories=[], etag="shown") == {"error": "BAD_REQUEST"}
    assert stack.todoist.calls == []


def test_native_mail_with_a_frozen_direct_filing_is_not_deletable(stack):
    from todofy.runtime import plus_mail

    stack.core.env.TASK_SOURCE = "tasks"
    stack.mail(E1, "filing", received=AT)
    asyncio.run(
        stack.runtime.plus_receipts.start(
            stack.core,
            str(uuid.uuid4()),
            "FileMailItem",
            "hash",
            [
                {
                    "method": "UpdateTask",
                    "body": {
                        "task": {"name": "tasks/filing", "project_id": "inbox-p"},
                        "request_id": str(uuid.uuid4()),
                    },
                }
            ],
        )
    )
    deletable, _, _ = asyncio.run(plus_mail._deletions(stack.core, ["filing"]))
    assert deletable == set()


def test_delete_all_deletes_exactly_the_untouched_mail_and_keeps_every_other(stack):
    for index in range(1, 9):
        stack.mail(str(uuid.UUID(int=index)), f"t{index}", received=AT - index)
    stack.todoist.tasks["t2"]["labels"] = ["context"]
    stack.todoist.tasks["t3"]["priority"] = 2
    stack.todoist.tasks["t4"]["due"] = {"date": "2026-10-20"}
    stack.todoist.tasks["t5"]["note_count"] = 1
    stack.todoist.add("t6-step", parent_id="t6")
    stack.todoist.tasks["t7"]["project_id"] = "work-p"
    stack.todoist.add("own")  # not mail
    stack.d1.db.execute("INSERT INTO plan_tasks (id, provider, external_id, created_at) VALUES (1, 'todoist', 't8', 1)")
    stack.d1.db.execute("INSERT INTO plan_tasks (id, provider, external_id, created_at) VALUES (2, 'todoist', 'x', 1)")
    stack.d1.db.execute("INSERT INTO plan_edges (task_id, prerequisite_id, created_at) VALUES (2, 1, 1)")
    ids = [f"t{index}" for index in range(1, 9)] + ["own", "gone"]
    answer = stack.call("DeleteMailItems", task_ids=ids, request_id=str(uuid.uuid4()))
    # "gone" is in no project any more: it counts as deleted, as ITEM_NOT_FOUND does, so its row leaves the list.
    assert answer == {"deleted_task_ids": ["t1", "gone"], "kept_task_ids": ids[1:9]}
    assert "t1" not in stack.todoist.tasks and {"t2", "own", "t6-step"} <= set(stack.todoist.tasks)
    # One read of the project, one Sync, one read by ID of those sent and those the project read did not find.
    assert stack.todoist.calls[-3:] == ["tasks:project_id", "sync:1", "tasks:ids"]
    [(method, state, commands, result)] = stack.receipts()
    assert (method, state, commands, json.loads(result)) == (
        "DeleteMailItems",
        "done",
        None,
        {"kept": list(range(1, 9))},
    )


def test_a_repeated_delete_reads_the_frozen_batch_again_and_deletes_nothing_twice(stack):
    ids = [f"t{index}" for index in range(150)]
    for index, task_id in enumerate(ids):
        stack.mail(str(uuid.UUID(int=index + 1)), task_id, received=AT - index)
    request = {"task_ids": ids, "request_id": str(uuid.uuid4())}
    stack.todoist.lose_answer = True
    assert stack.call("DeleteMailItems", **request) == {"error": "UNAVAILABLE"}
    assert len(stack.todoist.tasks) == 50  # the first 100 went before the answer was lost
    # The owner touches one that is still there, and new mail arrives: the repeat reads the frozen tasks again,
    # keeps the touched one and never adds the new one.
    stack.todoist.tasks["t140"]["labels"] = ["context"]
    stack.todoist.add("new-mail")
    stack.mail(str(uuid.UUID(int=999)), "new-mail", received=AT)
    calls = len(stack.todoist.calls)
    answer = stack.call("DeleteMailItems", **request)
    assert answer == {"deleted_task_ids": [task_id for task_id in ids if task_id != "t140"], "kept_task_ids": ["t140"]}
    assert stack.todoist.calls[calls:] == ["metadata", "tasks:project_id", "sync:49", "tasks:ids"]
    assert set(stack.todoist.tasks) == {"new-mail", "t140"}
    calls = len(stack.todoist.calls)
    assert stack.call("DeleteMailItems", **request) == answer
    assert stack.todoist.calls[calls:] == ["metadata"]  # the done replay reads no task and sends nothing


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"labels": ["context"]}, id="labelled"),
        pytest.param({"note_count": 1}, id="commented"),
        pytest.param({"priority": 3}, id="prioritised"),
        pytest.param({"due": {"date": "2026-10-20"}}, id="dated"),
        pytest.param({"project_id": "work-p"}, id="moved"),
        pytest.param("step", id="a_step"),
    ],
)
def test_a_delete_retry_keeps_mail_the_owner_changed_after_the_first_attempt(stack, monkeypatch, change):
    stack.mail(E1, "t1", received=AT)
    stack.mail(E2, "t2", received=AT - 1)
    monkeypatch.setattr(stack.runtime.todoist, "commands", unreachable(stack))
    request = {"task_ids": ["t1", "t2"], "request_id": str(uuid.uuid4())}
    assert stack.call("DeleteMailItems", **request) == {"error": "UNAVAILABLE"}
    assert set(stack.todoist.tasks) == {"t1", "t2"}  # nothing reached Todoist
    if change == "step":
        stack.todoist.add("t1-step", parent_id="t1")  # Todoist would delete it with its parent
    else:
        stack.todoist.tasks["t1"].update(change)
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(stack.runtime.todoist, "commands", recorded(stack, sent))
    assert stack.call("DeleteMailItems", **request) == {"deleted_task_ids": ["t2"], "kept_task_ids": ["t1"]}
    assert "t1" in stack.todoist.tasks and "t2" not in stack.todoist.tasks
    # The same UUID as frozen for t2; none for t1.
    assert [(command["args"]["id"], command["uuid"]) for command in sent] == [
        ("t2", stack.runtime.todoist.plus.command_id(request["request_id"], 1))
    ]


def test_delete_all_keeps_a_mail_with_an_unfinished_plus_write(stack, monkeypatch):
    stack.mail(E1, "t1", received=AT)
    stack.mail(E2, "t2", received=AT - 1)
    real = stack.todoist.commands
    monkeypatch.setattr(stack.runtime.todoist, "commands", unreachable(stack))
    # In another tab the owner commits t1 for this week; Todoist answered 429, so its label is not there yet.
    plan = {"task_id": "t1", "etag": stack.task("t1")["etag"], "stage": "weekly", "request_id": str(uuid.uuid4())}
    assert stack.call("SetTaskPlan", **plan) == {"error": "UNAVAILABLE"}
    # A deletion that never reached Todoist is not such a write: its tasks may still be deleted.
    assert stack.call("DeleteMailItems", task_ids=["t2"], request_id=str(uuid.uuid4())) == {"error": "UNAVAILABLE"}
    monkeypatch.setattr(stack.runtime.todoist, "commands", real)
    answer = stack.call("DeleteMailItems", task_ids=["t1", "t2"], request_id=str(uuid.uuid4()))
    assert answer == {"deleted_task_ids": ["t2"], "kept_task_ids": ["t1"]}
    # Once the write is finished, the task carries its label and is touched by Todoist's own fields.
    assert "task" in stack.call("SetTaskPlan", **plan) and stack.todoist.tasks["t1"]["labels"]


def test_deleted_mail_takes_its_summary_with_it_and_keeps_its_ledger_row(stack):
    stack.mail(E1, "t1", received=AT, summary="合成摘要正文：删除后不留存。", brief="合成简介。")
    stack.mail(E2, "t2", received=AT - 1, summary="另一封合成摘要。")
    stack.todoist.tasks["t2"]["labels"] = ["context"]
    answer = stack.call("DeleteMailItems", task_ids=["t1", "t2"], request_id=str(uuid.uuid4()))
    assert answer == {"deleted_task_ids": ["t1"], "kept_task_ids": ["t2"]}
    assert [row[0] for row in stack.d1.db.execute("SELECT event_id FROM summaries")] == [E2]
    assert {row[0] for row in stack.d1.db.execute("SELECT event_id FROM mail_events")} == {E1, E2}
    assert stack.call("ReadMailSummary", id=E1) == {}


def test_a_listed_mail_already_gone_counts_as_deleted_and_loses_its_summary(stack):
    """Gone before the request: deleted in Todoist, or by an earlier Delete all whose answer was lost and whose
    confirmation the owner then closed. It is not "kept for changes", and its row leaves the list."""
    stack.mail(E1, "t1", received=AT, summary="合成摘要。")
    stack.mail(E2, "t2", received=AT - 1)
    del stack.todoist.tasks["t1"]
    answer = stack.call("DeleteMailItems", task_ids=["t1", "t2"], request_id=str(uuid.uuid4()))
    assert answer == {"deleted_task_ids": ["t1", "t2"]}
    assert stack.todoist.calls[-3:] == ["tasks:project_id", "sync:1", "tasks:ids"]
    assert stack.d1.db.execute("SELECT count(*) FROM summaries").fetchone()[0] == 0


def test_a_task_still_active_after_the_deletions_is_unavailable(stack, monkeypatch):
    stack.mail(E1, "t1", received=AT)
    real = stack.todoist.commands

    async def ignored(core: Any, commands: list[dict[str, Any]], *, gone_ok: bool = False):
        answer = await real(core, [], gone_ok=gone_ok)
        return {**answer, "sync_status": {command["uuid"]: "ok" for command in commands}}

    monkeypatch.setattr(stack.runtime.todoist, "commands", ignored)
    request = {"task_ids": ["t1"], "request_id": str(uuid.uuid4())}
    assert stack.call("DeleteMailItems", **request) == {"error": "UNAVAILABLE"}
    monkeypatch.setattr(stack.runtime.todoist, "commands", real)
    assert stack.call("DeleteMailItems", **request) == {"deleted_task_ids": ["t1"]}


def test_delete_all_takes_one_to_two_hundred_tasks_and_one_request_per_id(stack):
    assert stack.call("DeleteMailItems", task_ids=[], request_id=str(uuid.uuid4())) == {"error": "BAD_REQUEST"}
    ids = [f"t{index}" for index in range(201)]
    assert stack.call("DeleteMailItems", task_ids=ids, request_id=str(uuid.uuid4())) == {"error": "BAD_REQUEST"}
    request_id = str(uuid.uuid4())
    stack.mail(E1, "t1", received=AT)
    assert stack.call("DeleteMailItems", task_ids=["t1"], request_id=request_id) == {"deleted_task_ids": ["t1"]}
    assert stack.call("DeleteMailItems", task_ids=["t2"], request_id=request_id) == {"error": "BAD_REQUEST"}


def test_mail_writes_wait_for_setup_and_stop_in_maintenance(stack):
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.call("DeleteMailItems", task_ids=["t1"], request_id=str(uuid.uuid4())) == {"error": "MAINTENANCE"}
    destination = {"provider": "todoist", "external_id": "work-p"}
    assert stack.call("UpdateMailSettings", destination=destination, etag="") == {"error": "MAINTENANCE"}
    assert stack.call("LookupMailItems", task_ids=[]) == {"categories_etag": MailSettings().etag}  # reads go on
    stack.core.env.MAINTENANCE_MODE = "false"
    stack.d1.db.execute("UPDATE plus_settings SET enabled = 0")
    assert stack.call("DeleteMailItems", task_ids=["t1"], request_id=str(uuid.uuid4())) == {
        "error": "ACTION_NOT_ALLOWED"
    }
    assert stack.call("UpdateMailSettings", destination=destination, etag="") == {"error": "ACTION_NOT_ALLOWED"}


def test_no_mail_text_reaches_the_logs_or_the_receipts(stack, capsys):
    subject_free = "合成机密简介不应出现在日志里。"
    stack.mail(E1, "t1", received=AT, summary=subject_free + "\n\n合成机密正文。")
    stack.mail(E2, "t2", received=AT - 1, summary="另一封合成邮件。", brief="合成机密模型简介。")
    stack.todoist.tasks["t1"]["content"] = "合成机密标题"
    saved = stack.settings(("office", "p2"))
    assert stack.call("LookupMailItems", task_ids=["t1", "t2"])["items"]
    assert stack.call("ReadMailSummary", id=E1)["summary"]
    assert "task" in filed(stack, "t1", saved["categories"][0], saved["etag"], str(uuid.uuid4()))
    assert stack.call("DeleteMailItems", task_ids=["t2"], request_id=str(uuid.uuid4())) == {"deleted_task_ids": ["t2"]}
    logged = capsys.readouterr().out
    receipts = json.dumps(stack.receipts(), ensure_ascii=False)
    for text in ("合成机密", "Synthetic subject", "另一封"):
        assert text not in logged and text not in receipts
