"""Mail operations, serialized by plus_api.handle's existing plus_lock.

Mail lists pending summaries directly. Converting one creates a generic Tasks Inbox task, or moves the linked
task of an adopted older entry. Deleting an entry removes its summary and preserves the event ledger and any
linked task. Optional shortcuts add ordinary label IDs and priority; Tasks has no Mail business fields.

A conversion's task write goes through its receipt (runtime/plus_receipts.py); completed receipts retain IDs only.
Logs carry no mail content.
"""

import json
from typing import Any

from todofy.core import mailbox
from todofy.core.gtd import rfc3339
from todofy.core.mailbox import MailSettings
from todofy.core.render import FOOTER_PREFIX, NO_SUBJECT
from todofy.core.sql import mailbox as sql
from todofy.runtime import plan_store, plus_tasks
from todofy.runtime import plus_receipts as receipts
from todofy.runtime.config import source_id, var
from todofy.runtime.interop import now_s

MAX_TASKS = 200
PRIORITIES = {"p1": 1, "p2": 2, "p3": 3, "p4": 4}
WIRE_PRIORITIES = {value: name for name, value in PRIORITIES.items()}


def _ref(external_id: str) -> dict[str, str]:
    return {"provider": plus_tasks.PROVIDER, "external_id": external_id}


def _task_id(ref: dict[str, Any] | None) -> str:
    if not ref or ref.get("provider") != plus_tasks.PROVIDER:
        raise plus_tasks.PlusError("BAD_REQUEST")
    return mailbox.check_id(ref.get("external_id", ""))


def _event_ids(request: dict[str, Any]) -> list[str]:
    ids = request.get("event_ids", [])
    if not 1 <= len(ids) <= MAX_TASKS or len(set(ids)) != len(ids):
        raise plus_tasks.PlusError("BAD_REQUEST")
    return [mailbox.check_id(event_id) for event_id in ids]


def _settings_answer(settings: MailSettings) -> dict[str, Any]:
    return {
        "categories": [
            {"id": str(category.id), "label": _ref(category.label_id), "priority": WIRE_PRIORITIES[category.priority]}
            for category in settings.categories
        ],
        "etag": settings.etag,
    }


# ---- reads ----------------------------------------------------------------------------------------------------


async def list_items(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """Mail is a bounded summary page; reading it never requires a Tasks snapshot."""
    size = request.get("page_size", 0) or 25
    if not 1 <= size <= 50:
        raise plus_tasks.PlusError("BAD_REQUEST")
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
            item["task"] = _ref(row["task_id"])
        items.append(item)
    settings = _settings_answer(plan_store.mail_settings_of(*saved))
    return {
        "mail_items": items,
        "categories": settings["categories"],
        "categories_etag": settings["etag"],
        "next_page_token": mailbox.next_page(rows[size - 1]) if len(rows) > size else "",
    }


async def read_summary(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ReadMailSummary: one primary-key read of the summary Todofy keeps; empty when there is none."""
    row = await core.env.DB.prepare(sql.SUMMARY.sql).bind(mailbox.check_id(request.get("id", ""))).first()
    return {"summary": dict(row)["summary"] if row is not None else ""}


async def read_settings(core: Any) -> dict[str, Any]:
    """ReadMailSettings: the categories and their etag, from D1 alone."""
    return _settings_answer(await plan_store.mail_settings(core.env.DB))


# ---- writes ---------------------------------------------------------------------------------------------------


async def update_categories(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """UpdateMailCategories: the whole set in one D1 batch, by etag; the saved categories sent again are a replay.

    Each label must still exist; every ordinary label may be a category. The destination saved before Tasks was the
    only store stays as it is: nothing reads it, and a request need not send one."""
    db = core.env.DB
    requested = []
    for category in request.get("categories", []):
        priority = PRIORITIES.get(category.get("priority", ""))
        if priority is None:
            raise plus_tasks.PlusError("BAD_REQUEST")
        requested.append((_task_id(category.get("label")), priority))
    if request.get("destination"):
        _task_id(request["destination"])
    settings = await plan_store.mail_settings(db)
    if [(c.label_id, c.priority) for c in settings.categories] == requested:
        return _settings_answer(settings)
    if request.get("etag") != settings.etag:
        raise plus_tasks.PlusError("ETAG_MISMATCH")
    labels = await plus_tasks.labels(core)
    if any(label_id not in labels for label_id, _ in requested):
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    saved, archived = mailbox.replace_categories(
        list(settings.categories),
        [(label_id, labels[label_id], priority) for label_id, priority in requested],
        await plan_store.next_category_id(db),
    )
    updated = MailSettings(tuple(saved), settings.destination)
    await plan_store.save_mail_settings(db, settings, updated, archived, now_s())
    return _settings_answer(updated)


async def _category(core: Any, request: dict[str, Any]) -> tuple[str, int] | None:
    """The label ID and priority of the category a conversion files with, if any."""
    if not request.get("category_id"):
        return None
    settings = await plan_store.mail_settings(core.env.DB)
    if request.get("categories_etag") != settings.etag:
        raise plus_tasks.PlusError("ETAG_MISMATCH")
    category = next((c for c in settings.categories if str(c.id) == request["category_id"]), None)
    if category is None:
        raise plus_tasks.PlusError("BAD_REQUEST")
    if category.label_id not in await plus_tasks.labels(core):
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    return category.label_id, category.priority


async def _open_linked_task(core: Any, task_id: str) -> dict[str, Any] | None:
    """The task an older Mail row links to while it is still open; None once it was deleted or completed."""
    try:
        task = await plus_tasks.task(core, task_id)
    except plus_tasks.PlusError as error:
        if error.reason == "NOT_FOUND":
            return None
        raise
    return None if task.get("checked") else task


def _converted(task: dict[str, Any]) -> dict[str, Any]:
    """ConvertMailItemResponse.task: the task's ID, title and project. PlanningTask's other fields were Plan's, which
    reads Tasks itself now."""
    return {"id": str(task["id"]), "title": task.get("content", ""), "project_id": str(task.get("project_id") or "")}


async def convert(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ConvertMailItem: create the first generic Inbox task on owner action; then consume the Mail entry."""
    event_id, request_id = mailbox.check_id(request["event_id"]), request["request_id"]
    digest = mailbox.fingerprint(["ConvertMailItem", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise plus_tasks.PlusError("BAD_REQUEST")
    if previous is not None and previous.result is not None:
        return {"task": _converted(await plus_tasks.task(core, previous.result["task_id"]))}
    if previous is None:
        saved = await core.env.DB.prepare(sql.NATIVE_ITEM.sql).bind(event_id).first()
        if saved is None:
            raise plus_tasks.PlusError("NOT_FOUND")
        row = dict(saved)
        if request.get("etag") != mailbox.item_etag(row):
            raise plus_tasks.PlusError("ETAG_MISMATCH")
        filed = await _category(core, request)
        # A linked task the owner deleted or completed is not moved back: the mail becomes a new Inbox task.
        task = await _open_linked_task(core, row["task_id"]) if row["task_id"] else None
        if task is not None:
            if task.get("parent_id"):
                raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
            fields: dict[str, Any] = {"project_id": "", "section_id": "", "parent_id": ""}
            if filed:
                fields.update(label_ids=list(dict.fromkeys([*task["_native_label_ids"], filed[0]])), priority=filed[1])
            body = {
                "task": {"name": f"tasks/{row['task_id']}", **fields},
                "etag": task["_native_etag"],
                "update_mask": ",".join(fields),
                "request_id": mailbox.command_id(request_id),
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
                "task_id": mailbox.command_id("mail-task:" + event_id),
                "request_id": mailbox.command_id("mail-create:" + event_id),
            }
            if filed:
                body["task"].update(label_ids=[filed[0]], priority=filed[1])
            operation = {"method": "CreateTask", "body": body}
        commands = [operation]
        await receipts.start(core, request_id, "ConvertMailItem", digest, commands)
    else:
        commands = previous.commands
    result = await plus_tasks.commands(core, commands)
    task_id = result["task_ids"][0]
    await (
        core.env.DB.prepare(sql.TRIAGE.sql)
        .bind(task_id, now_s(), int(request["category_id"]) if request.get("category_id") else None, event_id)
        .run()
    )
    receipts.finish(core.sql, request_id, {"task_id": task_id})
    return {"task": _converted(await plus_tasks.task(core, task_id))}


async def delete_summaries(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """DeleteMailSummaries: delete pending summaries, preserving the event ledger and every generic Tasks resource."""
    ids = _event_ids(request)
    request_id = request["request_id"]
    digest = mailbox.fingerprint(["DeleteMailSummaries", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise plus_tasks.PlusError("BAD_REQUEST")
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
