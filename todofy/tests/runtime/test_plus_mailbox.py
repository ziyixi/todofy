"""The Mailbox through the real gateway, Python DO and D1 with the extension's token: LookupMailItems,
ReadMailSummary, the mail settings, FileMailItem, DeleteMailItems, and the one-time brief backfill from the alarm.
Todoist and Gemini are fakes; every mail, task and summary is synthetic.
"""

import json
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest

from tests.fakes.gemini_fake import API_KEY as GEMINI_KEY
from tests.fakes.gemini_fake import GeminiFake, text_reply
from tests.fakes.plus_fake import PlusFake
from tests.runtime.harness import CSRF_SIGNING_KEY, Worker, reason, start_gateway, wait_until
from todofy.core.prompts import BRIEF_EMAIL

INBOX = "inbox-project"
NOW = int(time.time())


@dataclass
class Stack:
    worker: Worker
    upstream: PlusFake
    gemini: GeminiFake
    token: str

    def call(self, path: str, body: dict[str, Any] | None = None) -> Any:
        headers = {"authorization": "Bearer " + self.token}
        if body is None:
            response = self.worker.hooks.get("/api/plus/v1/" + path, headers=headers)
        else:
            response = self.worker.hooks.post("/api/plus/v1/" + path, json=body, headers=headers)
        return response.json() if response.status_code == 200 else reason(response)

    def tasks(self) -> dict[str, dict[str, Any]]:
        """Every task, page by page (the fake answers two a page)."""
        found: dict[str, dict[str, Any]] = {}
        params: dict[str, Any] = {"page_size": 200}
        while True:
            response = self.worker.hooks.get(
                "/api/plus/v1/tasks", params=params, headers={"authorization": "Bearer " + self.token}
            ).json()
            found.update((task["id"], task) for task in response["planning_tasks"])
            if not response.get("next_page_token"):
                return found
            params["page_token"] = response["next_page_token"]


def mail(worker: Worker, upstream: PlusFake, task_id: str, *, brief: str | None = None, **fields: Any) -> str:
    """A completed Mail Hero event (its ledger row and summary) and its task in the mail project."""
    event_id = str(uuid.uuid4())
    brief_sql = "NULL" if brief is None else f"'{brief}'"
    worker.d1(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, state, task_id, created_at, updated_at)"
        f" VALUES ('mail-hero-personal', '{event_id}', '{'0' * 64}', 'complete', '{task_id}', {NOW}, {NOW});"
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id, brief)"
        f" VALUES ('{event_id}', {NOW}, '合成主题 {task_id}', '旧格式的合成摘要 {task_id}。第二句。', 'm',"
        f" '{task_id}', {brief_sql})"
    )
    upstream.add(task_id, **{"project_id": INBOX, "note_count": 0, **fields})
    return event_id


def backfilled(worker: Worker) -> dict[str, str | None] | None:
    """The briefs of the mail the backfill finds, once it has written both it asks the model for."""
    rows = worker.d1(
        "SELECT task_id, brief FROM summaries WHERE task_id IN ('old-a', 'old-b', 'old-quick', 'old-briefed')"
    )
    briefs = {row["task_id"]: row["brief"] for row in rows}
    return briefs if briefs.get("old-a") and briefs.get("old-b") else None


@pytest.fixture(scope="module")
def stack(tmp_path_factory) -> Iterator[Stack]:
    upstream, gemini = PlusFake(), GeminiFake()
    upstream.labels.append({"id": "40", "name": "quick"})
    # The mail project grows past the five pages DeleteMailItems reads at two a page (PROJECT_PAGES).
    upstream.page_limit = 3
    process = start_gateway(
        tmp_path_factory.mktemp("plus-mailbox-worker"),
        {
            "TODOIST_API_BASE": upstream.url,
            "TODOIST_API_KEY": "synthetic-plus-key",
            "GEMINI_API_BASE": gemini.url,
            "GEMINI_API_KEY": GEMINI_KEY,
            "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
            "TODOIST_DEFAULT_PROJECT_ID": INBOX,
            # The backfill's model calls a second apart, not production's 30 s (mail_briefs.PACE).
            "MAIL_BRIEFS_PACE_MS": "1000",
        },
    )
    try:
        worker = next(process)
        plan = worker.owner.get("/api/plus/v1/plan:read").json()["plan"]
        confirmed = worker.post_owner(
            "/api/plus/v1/plan:confirmPlanMapping", {"etag": plan["etag"], "request_id": str(uuid.uuid4())}
        )
        assert confirmed.status_code == 200, confirmed.text
        request = {"display_name": "Synthetic Chrome", "request_id": str(uuid.uuid4())}
        token = worker.post_owner("/api/plus/v1/connections:issueExtensionConnection", request).json()["token"]
        # Mail summarised before the release (no brief), then the deploy's first alarm: the one-time backfill asks
        # the model about the two still in the Mailbox (test_the_backfill_ran_once_after_the_deploy). No Plus call
        # wakes the alarm, so it first runs here, with Plus set up.
        for task_id in ("old-a", "old-b"):
            mail(worker, upstream, task_id)
        mail(worker, upstream, "old-briefed", brief="完成时写的简介。")
        mail(worker, upstream, "old-quick", labels=["quick"])
        gemini.queue_generate(text_reply("合成补写的简介一。"))
        gemini.queue_generate(text_reply("合成补写的简介二。\n第二行"))
        assert worker.trigger_cron().status_code == 200
        wait_until(lambda: backfilled(worker), 60, "the brief backfill")
        yield Stack(worker, upstream, gemini, token)
    finally:
        process.close()
        upstream.close()
        gemini.close()


def test_lookup_and_summary_read_d1_alone(stack):
    event_id = mail(stack.worker, stack.upstream, "look", brief=None)
    stack.worker.d1(f"UPDATE summaries SET summary = '第一句简介。\n\n**要点**\n- 合成' WHERE event_id = '{event_id}'")
    calls = len(stack.upstream.received())
    answer = stack.call("mailItems:lookup", {"task_ids": ["look", "old-briefed", "unknown"]})
    items = {item["task"]["external_id"]: item for item in answer["items"]}
    assert set(items) == {"look", "old-briefed"}
    assert items["look"]["id"] == event_id and items["look"]["brief"] == "第一句简介。"
    assert items["old-briefed"]["brief"] == "完成时写的简介。"
    assert items["look"]["receive_time"] == time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW))
    summary = stack.call(f"mailItems:readMailSummary?id={event_id}")
    assert summary == {"summary": "第一句简介。\n\n**要点**\n- 合成"}
    assert len(stack.upstream.received()) == calls  # no Todoist call
    assert stack.call("mailItems:lookup", {"task_ids": ["x"] * 201}) == "BAD_REQUEST"


def test_settings_are_saved_in_the_planning_store_and_filing_is_one_sync(stack):
    # For an extension before protocol 6, the account Inbox is the only destination to choose, and it sends it.
    settings = stack.call("mailSettings:read")
    assert [project["id"] for project in settings["projects"]] == ["account-inbox"]
    assert settings["destination"] == {"provider": "todoist", "external_id": "account-inbox"}
    calls = len(stack.upstream.received("GET", "/api/v1/projects"))
    saved = stack.call(
        "mailSettings:updateMailSettings",
        {
            "categories": [
                {"label": {"provider": "todoist", "external_id": "1"}, "priority": "p2"},
                {"label": {"provider": "todoist", "external_id": "40"}, "priority": "p4"},
            ],
            "destination": settings["destination"],
            "etag": settings["etag"],
        },
    )
    assert [category["priority"] for category in saved["categories"]] == ["p2", "p4"]
    assert saved["destination"] == settings["destination"]  # stored as sent, so an older Mailbox offers them
    assert len(stack.upstream.received("GET", "/api/v1/projects")) == calls  # the destination is never checked
    assert stack.worker.d1("SELECT name, priority FROM plan_categories ORDER BY sort_order") == [
        {"name": "office · P2", "priority": 2},
        {"name": "quick · P4", "priority": 4},
    ]
    [binding] = stack.worker.d1("SELECT value FROM plan_settings WHERE key = 'todoist.mail'")
    assert json.loads(binding["value"])["destination"] == "account-inbox"
    # A lookup of no task answers the categories alone, with the deprecated destination (the Mailbox with nothing
    # to ask about).
    assert stack.call("mailItems:lookup", {"task_ids": []}) == {
        "categories": saved["categories"],
        "categories_etag": saved["etag"],
        "destination": saved["destination"],
    }
    # The saved categories sent again are a replay, whatever the etag and the destination.
    replay = {
        "categories": [{"label": c["label"], "priority": c["priority"]} for c in saved["categories"]],
        "destination": {"provider": "todoist", "external_id": "work-project"},
        "etag": "stale",
    }
    assert stack.call("mailSettings:updateMailSettings", replay) == saved

    mail(stack.worker, stack.upstream, "file-me", labels=["home", "context"])
    task = stack.tasks()["file-me"]
    batches = len(stack.upstream.command_batches())
    filed = stack.call(
        "mailItems:fileMailItem",
        {
            "task_id": "file-me",
            "etag": task["etag"],
            "category_id": saved["categories"][0]["id"],
            "categories_etag": saved["etag"],
            "request_id": str(uuid.uuid4()),
        },
    )
    assert filed["task"]["project_id"] == "account-inbox" and filed["task"]["area"] == "work"
    stored = stack.upstream.tasks["file-me"]
    assert (sorted(stored["labels"]), stored["priority"], stored["project_id"]) == (
        ["context", "office"],
        3,
        "account-inbox",
    )
    sent = stack.upstream.command_batches()[batches:]
    assert [[command["type"] for command in commands] for commands in sent] == [["item_update", "item_move"]]


def test_a_filing_retry_never_writes_a_renamed_label(stack):
    """After the settings test: categories office · P2 and quick · P4 (label 40)."""
    saved = stack.call("mailItems:lookup", {"task_ids": []})
    quick = next(category for category in saved["categories"] if category["label"]["external_id"] == "40")
    mail(stack.worker, stack.upstream, "file-retry")
    request = {
        "task_id": "file-retry",
        "etag": stack.tasks()["file-retry"]["etag"],
        "category_id": quick["id"],
        "categories_etag": saved["categories_etag"],
        "request_id": str(uuid.uuid4()),
    }
    stack.upstream.throttle_commands_once = True
    assert stack.call("mailItems:fileMailItem", request) == "UNAVAILABLE"
    label = next(label for label in stack.upstream.labels if label["id"] == "40")
    batches = len(stack.upstream.command_batches())
    try:
        # Renamed in Todoist before the same category is chosen again: the frozen name is never resent.
        label["name"] = "quick-later"
        assert stack.call("mailItems:fileMailItem", request) == "ETAG_MISMATCH"
    finally:
        label["name"] = "quick"
    assert stack.upstream.command_batches()[batches:] == []
    assert stack.upstream.tasks["file-retry"]["project_id"] == INBOX


def test_filing_to_the_inbox_alone_is_one_move_and_a_retry_moves_nothing_twice(stack):
    mail(stack.worker, stack.upstream, "to-inbox", labels=["home"], priority=3)
    request = {
        "task_id": "to-inbox",
        "etag": stack.tasks()["to-inbox"]["etag"],
        "category_id": "",
        "categories_etag": "",
        "request_id": str(uuid.uuid4()),
    }
    batches = len(stack.upstream.command_batches())
    stack.upstream.fail_commands_once = True
    assert stack.call("mailItems:fileMailItem", request) == "UNAVAILABLE"
    filed = stack.call("mailItems:fileMailItem", request)
    assert filed["task"]["project_id"] == "account-inbox" and filed["task"]["labels"] == ["home"]
    assert stack.upstream.tasks["to-inbox"]["priority"] == 3
    # The first try's move landed: the retry found the task out of the mail project and sent nothing.
    sent = stack.upstream.command_batches()[batches:]
    assert [[(command["type"], command["args"]) for command in commands] for commands in sent] == [
        [("item_move", {"id": "to-inbox", "project_id": "account-inbox"})]
    ]


def deletes(stack: Stack) -> list[dict[str, Any]]:
    return [command for command in stack.upstream.commands() if command["type"] == "item_delete"]


def test_delete_all_deletes_only_untouched_mail_and_a_repeat_deletes_nothing_twice(stack):
    events = {task_id: mail(stack.worker, stack.upstream, task_id) for task_id in ("del-1", "del-2", "del-3")}
    mail(stack.worker, stack.upstream, "del-touched", due={"date": "2026-12-01"})
    mail(stack.worker, stack.upstream, "del-commented", note_count=2)
    stack.upstream.add("own-task", project_id=INBOX, note_count=0)  # no ledger row: not mail
    ids = ["del-1", "del-2", "del-3", "del-touched", "del-commented", "own-task"]
    request = {"task_ids": ids, "request_id": str(uuid.uuid4())}
    sent = len(deletes(stack))
    stack.upstream.fail_commands_once = True
    assert stack.call("mailItems:deleteMailItems", request) == "UNAVAILABLE"
    # The deletions went through, the answer was lost: the repeat finds them gone and sends nothing again.
    answer = stack.call("mailItems:deleteMailItems", request)
    assert answer == {"deleted_task_ids": ["del-1", "del-2", "del-3"], "kept_task_ids": ids[3:]}
    assert {"del-touched", "del-commented", "own-task"} <= set(stack.upstream.tasks)
    assert not {"del-1", "del-2", "del-3"} & set(stack.upstream.tasks)
    assert len(deletes(stack)) == sent + 3
    assert stack.call("mailItems:deleteMailItems", request) == answer
    assert len(deletes(stack)) == sent + 3
    # Their summaries went with them; the ledger keeps its rows of IDs and states.
    listed = ", ".join(f"'{event_id}'" for event_id in events.values())
    assert stack.worker.d1(f"SELECT count(*) AS n FROM summaries WHERE event_id IN ({listed})") == [{"n": 0}]
    assert stack.worker.d1(f"SELECT count(*) AS n FROM mail_events WHERE event_id IN ({listed})") == [{"n": 3}]


def test_a_delete_retry_reads_the_frozen_tasks_again_and_keeps_those_changed_meanwhile(stack):
    for task_id in ("retry-1", "retry-2", "retry-3"):
        mail(stack.worker, stack.upstream, task_id)
    request = {"task_ids": ["retry-1", "retry-2", "retry-3"], "request_id": str(uuid.uuid4())}
    stack.upstream.throttle_commands_once = True
    assert stack.call("mailItems:deleteMailItems", request) == "UNAVAILABLE"
    assert {"retry-1", "retry-2", "retry-3"} <= set(stack.upstream.tasks)  # nothing reached Todoist
    # Before Try again, the owner labels one in Todoist and gives another a step.
    stack.upstream.tasks["retry-1"]["labels"] = ["home"]
    stack.upstream.add("retry-2-step", project_id=INBOX, parent_id="retry-2", note_count=0)
    sent = len(deletes(stack))
    answer = stack.call("mailItems:deleteMailItems", request)
    assert answer == {"deleted_task_ids": ["retry-3"], "kept_task_ids": ["retry-1", "retry-2"]}
    assert [command["args"]["id"] for command in deletes(stack)[sent:]] == ["retry-3"]
    assert {"retry-1", "retry-2", "retry-2-step"} <= set(stack.upstream.tasks)


def test_delete_all_keeps_mail_an_unfinished_plus_write_is_changing(stack):
    """The guard reads the started receipts in the object's own SQLite (json_each over their commands)."""
    for task_id in ("busy-1", "busy-2"):
        mail(stack.worker, stack.upstream, task_id)
    task = stack.tasks()["busy-1"]
    stack.upstream.throttle_commands_once = True
    write = {"task_id": "busy-1", "etag": task["etag"], "stage": "weekly", "request_id": str(uuid.uuid4())}
    assert stack.call("tasks:setTaskPlan", write) == "UNAVAILABLE"
    request = {"task_ids": ["busy-1", "busy-2"], "request_id": str(uuid.uuid4())}
    answer = stack.call("mailItems:deleteMailItems", request)
    assert answer == {"deleted_task_ids": ["busy-2"], "kept_task_ids": ["busy-1"]}
    assert "busy-1" in stack.upstream.tasks


def test_the_backfill_ran_once_after_the_deploy(stack):
    """Last in this module: the mail every test above added without a brief stands for mail summarised before the
    release, too, but the backfill had already run. It asked once for each mail then in the Mailbox."""
    briefs = backfilled(stack.worker)
    assert briefs is not None
    assert sorted([briefs["old-a"], briefs["old-b"]]) == ["合成补写的简介一。", "合成补写的简介二。"]
    assert briefs["old-briefed"] == "完成时写的简介。" and briefs["old-quick"] is None  # not in the Mailbox
    calls = [call for call in stack.gemini.calls() if call.system == BRIEF_EMAIL]
    assert len(calls) == 2 and all("<<<BEGIN_CONTENT>>>" in call.user for call in calls)
    assert stack.worker.d1("SELECT count(*) AS n FROM summaries WHERE brief IS NULL")[0]["n"] > 1
    for _ in range(2):
        assert stack.worker.trigger_cron().status_code == 200
        time.sleep(2)
    assert len([call for call in stack.gemini.calls() if call.system == BRIEF_EMAIL]) == 2
