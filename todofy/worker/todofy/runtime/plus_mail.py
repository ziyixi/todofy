"""Mail operations, serialized by plus_api.handle's existing plus_lock.

Mail lists pending summaries directly. Converting one creates a generic Tasks Inbox task, or moves the linked
task of an adopted older entry. Deleting an entry removes its summary and preserves the event ledger and any
linked task. Optional shortcuts add ordinary label IDs and priority; Tasks has no Mail business fields.

All task writes use the existing receipt/executor boundary; completed receipts retain IDs only. Logs carry no
mail content.
"""

import json
from typing import Any

from todofy.core import mailbox, plus
from todofy.core.gtd import rfc3339
from todofy.core.mailbox import MailSettings
from todofy.core.render import FOOTER_PREFIX, NO_SUBJECT
from todofy.core.sql import mailbox as sql
from todofy.runtime import native_plus, native_tasks, plan_store
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.config import source_id, var
from todofy.runtime.interop import now_s

MAX_TASKS = 200
PRIORITIES = {"p1": 1, "p2": 2, "p3": 3, "p4": 4}
WIRE_PRIORITIES = {value: name for name, value in PRIORITIES.items()}


def _ref(external_id: str, provider: str = "todoist") -> dict[str, str]:
    return {"provider": provider, "external_id": external_id}


def _todoist_id(ref: dict[str, Any] | None, provider: str = "todoist") -> str:
    if not ref or ref.get("provider") != provider:
        raise todoist.PlusError("BAD_REQUEST")
    return plus.check_id(ref.get("external_id", ""))


def _task_ids(request: dict[str, Any], *, least: int = 0) -> list[str]:
    ids = request.get("task_ids", [])
    if not least <= len(ids) <= MAX_TASKS or len(set(ids)) != len(ids):
        raise todoist.PlusError("BAD_REQUEST")
    return [plus.check_id(task_id) for task_id in ids]


def _settings_answer(settings: MailSettings, provider: str = "todoist") -> dict[str, Any]:
    answer: dict[str, Any] = {
        "categories": [
            {
                "id": str(category.id),
                "label": _ref(category.label_id, provider),
                "priority": WIRE_PRIORITIES[category.priority],
            }
            for category in settings.categories
        ],
        "etag": settings.etag,
    }
    if settings.destination and provider != "tasks":
        answer["destination"] = _ref(settings.destination, provider)
    return answer


# ---- reads ----------------------------------------------------------------------------------------------------


async def list_items(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """Native Mail is a bounded summary page; reading it never requires a Tasks snapshot."""
    if not native_tasks.enabled(core.env):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    size = request.get("page_size", 0) or 25
    if not 1 <= size <= 50:
        raise todoist.PlusError("BAD_REQUEST")
    at, last = mailbox.page_cursor(request.get("page_token", ""))
    db = core.env.DB
    page, *saved = await db.batch(
        [
            db.prepare(sql.NATIVE_ITEMS.sql).bind(source_id(core.env), at, last, size + 1),
            *plan_store.mail_settings_statements(db),
        ]
    )
    rows = [dict(row) for row in page.results]
    items = []
    for row in rows[:size]:
        item = {
            "id": row["event_id"],
            "title": row["subject"] if row["subject"].strip() else NO_SUBJECT,
            "etag": mailbox.item_etag(row),
            "brief": row["brief"] or mailbox.brief_of(row["head"] or ""),
            "receive_time": rfc3339(int(row["received_at"])),
            "has_summary": bool(row["has_summary"]),
        }
        if row["task_id"]:
            item["task"] = _ref(row["task_id"], "tasks")
        items.append(item)
    settings = _settings_answer(plan_store.mail_settings_of(*saved), "tasks")
    return {
        "mail_items": items,
        "categories": settings["categories"],
        "categories_etag": settings["etag"],
        "next_page_token": mailbox.next_page(rows[size - 1]) if len(rows) > size else "",
    }


async def read_summary(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ReadMailSummary: one primary-key read of the summary Todofy keeps; empty when there is none."""
    row = await core.env.DB.prepare(sql.SUMMARY.sql).bind(plus.check_id(request.get("id", ""))).first()
    return {"summary": dict(row)["summary"] if row is not None else ""}


async def read_settings(core: Any) -> dict[str, Any]:
    """ReadMailSettings: the categories and their etag, from D1 alone."""
    return _settings_answer(await plan_store.mail_settings(core.env.DB), todoist.provider(core))


# ---- writes ---------------------------------------------------------------------------------------------------


async def update_settings(core: Any, request: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """UpdateMailCategories: the whole set in one D1 batch, by etag; the saved categories sent again are a replay.

    Each label must still exist. Native categories may use every ordinary label; the legacy adapter excludes its
    planning-label workarounds. The legacy destination is stored but ignored; native clients need not send it."""
    db = core.env.DB
    requested = []
    for category in request.get("categories", []):
        priority = PRIORITIES.get(category.get("priority", ""))
        if priority is None:
            raise todoist.PlusError("BAD_REQUEST")
        requested.append((_todoist_id(category.get("label"), todoist.provider(core)), priority))
    settings = await plan_store.mail_settings(db)
    native = native_tasks.enabled(core.env)
    destination = settings.destination if native else _todoist_id(request.get("destination"), todoist.provider(core))
    if native and request.get("destination"):
        _todoist_id(request["destination"], "tasks")
    if [(c.label_id, c.priority) for c in settings.categories] == requested:
        return _settings_answer(settings, todoist.provider(core))
    if request.get("etag") != settings.etag:
        raise todoist.PlusError("ETAG_MISMATCH")
    labels = {label["id"]: label for label in current["available_labels"]}
    if any(
        label_id not in labels or (not native and not plus.mail_label(labels[label_id], current["labels"]))
        for label_id, _ in requested
    ):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    saved, archived = mailbox.replace_categories(
        list(settings.categories),
        [(label_id, labels[label_id]["label"], priority) for label_id, priority in requested],
        await plan_store.next_category_id(db),
    )
    updated = MailSettings(tuple(saved), destination)
    await plan_store.save_mail_settings(db, settings, updated, archived, now_s())
    return _settings_answer(updated, todoist.provider(core))


async def _category(core: Any, request: dict[str, Any], current: dict[str, Any]) -> tuple[str, int] | None:
    native = native_tasks.enabled(core.env)
    if request.get("category_id"):
        settings = await plan_store.mail_settings(core.env.DB)
        if request.get("categories_etag") != settings.etag:
            raise todoist.PlusError("ETAG_MISMATCH")
        category = next((c for c in settings.categories if str(c.id) == request["category_id"]), None)
        if category is None:
            raise todoist.PlusError("BAD_REQUEST")
        label = next((label for label in current["available_labels"] if label["id"] == category.label_id), None)
        if label is None or (not native and not plus.mail_label(label, current["labels"])):
            # Todoist would create a label for a name it does not know; Plus never creates one.
            raise todoist.PlusError("ACTION_NOT_ALLOWED")
        return category.label_id if native else label["label"], category.priority
    return None


async def _open_linked_task(core: Any, task_id: str) -> dict[str, Any] | None:
    """The task an older Mail row links to while it is still open; None once it was deleted or completed."""
    try:
        task = await todoist.task(core, task_id)
    except todoist.PlusError as error:
        if error.reason == "NOT_FOUND":
            return None
        raise
    return None if task.get("checked") else task


async def convert(core: Any, request: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """ConvertMailItem: create the first generic Inbox task on owner action; then consume the Mail entry."""
    if not native_tasks.enabled(core.env):
        raise todoist.PlusError("BAD_REQUEST")
    event_id, request_id = plus.check_id(request["event_id"]), request["request_id"]
    digest = plus.fingerprint(["ConvertMailItem", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise todoist.PlusError("BAD_REQUEST")
    if previous is not None and previous.result is not None:
        task = await todoist.task(core, previous.result["task_id"])
        return {"task": plus.task_view(task, current["today"], current["labels"])}
    if previous is None:
        saved = await core.env.DB.prepare(sql.NATIVE_ITEM.sql).bind(event_id).first()
        if saved is None:
            raise todoist.PlusError("NOT_FOUND")
        row = dict(saved)
        if request.get("etag") != mailbox.item_etag(row):
            raise todoist.PlusError("ETAG_MISMATCH")
        filed = await _category(core, request, current)
        # A linked task the owner deleted or completed is not moved back: the mail becomes a new Inbox task.
        task = await _open_linked_task(core, row["task_id"]) if row["task_id"] else None
        if task is not None:
            if task.get("parent_id"):
                raise todoist.PlusError("ACTION_NOT_ALLOWED")
            fields: dict[str, Any] = {"project_id": "", "section_id": "", "parent_id": ""}
            if filed:
                fields.update(label_ids=list(dict.fromkeys([*task["_native_label_ids"], filed[0]])), priority=filed[1])
            body = {
                "task": {"name": f"tasks/{row['task_id']}", **fields},
                "etag": task["_native_etag"],
                "update_mask": ",".join(fields),
                "request_id": plus.command_id(request_id),
            }
            operation = {"method": "UpdateTask", "body": body}
        else:
            origin = var(core.env, "TASKS_PUBLIC_URL").rstrip("/")
            link = f"\n\n[查看完整邮件摘要]({origin}/?mail={event_id}#/mail)" if origin else ""
            footer = f"{link}\n\n{FOOTER_PREFIX}{event_id}"
            available = 16000 - len(footer.encode("utf-16-le")) // 2
            summary = row["summary"]
            notice = (
                "\n\n（任务描述已截断；完整摘要保留在 Mail 中。）"
                if mailbox.task_text(summary, available) != summary
                else ""
            )
            body = {
                "task": {
                    "title": mailbox.task_text(row["subject"] if row["subject"].strip() else NO_SUBJECT, 500),
                    "description": mailbox.task_text(summary, available - len(notice)) + notice + footer,
                },
                "task_id": plus.command_id("mail-task:" + event_id),
                "request_id": plus.command_id("mail-create:" + event_id),
            }
            if filed:
                body["task"].update(label_ids=[filed[0]], priority=filed[1])
            operation = {"method": "CreateTask", "body": body}
        commands = [operation]
        await receipts.start(core, request_id, "ConvertMailItem", digest, commands)
    else:
        commands = previous.commands
    result = await todoist._native(native_plus.commands(core, commands))
    task_id = result["task_ids"][0]
    await (
        core.env.DB.prepare(sql.TRIAGE.sql)
        .bind(task_id, now_s(), int(request["category_id"]) if request.get("category_id") else None, event_id)
        .run()
    )
    receipts.finish(core.sql, request_id, {"task_id": task_id})
    task = await todoist.task(core, task_id)
    return {"task": plus.task_view(task, current["today"], current["labels"])}


async def delete_summaries(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """DeleteMailSummaries: delete pending summaries, preserving the event ledger and every generic Tasks resource."""
    if not native_tasks.enabled(core.env):
        raise todoist.PlusError("BAD_REQUEST")
    ids = _task_ids({"task_ids": request["event_ids"]}, least=1)
    request_id = request["request_id"]
    digest = plus.fingerprint(["DeleteMailSummaries", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise todoist.PlusError("BAD_REQUEST")
    if previous is not None and previous.result is not None:
        kept = {ids[index] for index in previous.result["kept_events"]}
    else:
        await receipts.start(core, request_id, "DeleteMailSummaries", digest, [])
        bound = json.dumps(ids)
        _, remaining = await core.env.DB.batch(
            [
                core.env.DB.prepare(sql.FORGET_EVENTS.sql).bind(bound),
                core.env.DB.prepare(sql.EXISTING_EVENTS.sql).bind(bound),
            ]
        )
        kept = {dict(row)["event_id"] for row in remaining.results}
        receipts.finish(
            core.sql, request_id, {"kept_events": [index for index, value in enumerate(ids) if value in kept]}
        )
    return {
        "deleted_event_ids": [value for value in ids if value not in kept],
        "kept_event_ids": [value for value in ids if value in kept],
    }
