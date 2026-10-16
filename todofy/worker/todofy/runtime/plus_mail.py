"""The Mailbox's PlusService RPCs, run by plus_api.handle inside plus_lock (docs/todoist-plus.md, "Mailbox").

A mail item is a completed Mail Hero event's summaries row; the extension asks about the mail project tasks it
already holds. The categories are planning-store facts (runtime/plan_store.py), their labels the Todoist adapter's
(core/plus.py). The two writes that change Todoist take a receipt (runtime/plus_receipts.py), as every other one
does: FileMailItem's one Sync (labels and priority, then the move) and DeleteMailItems' frozen deletions, sent at
most SYNC_COMMANDS a request, after which the deleted mail's summaries go too (the owner's one way to delete them).
UpdateMailSettings writes D1 alone and replays by value. Logs carry no mail content.

``current`` is the caller's plan (plus_api.plan): the label mapping, the available labels and the account's day.
"""

import json
from typing import Any

from todofy.core import mailbox, plus
from todofy.core.gtd import rfc3339
from todofy.core.mailbox import MailSettings
from todofy.core.sql import mailbox as sql
from todofy.runtime import plan_store
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.config import source_id, var
from todofy.runtime.interop import now_s

MAX_TASKS = 200
PRIORITIES = {"p1": 1, "p2": 2, "p3": 3, "p4": 4}
WIRE_PRIORITIES = {value: name for name, value in PRIORITIES.items()}
MAX_PROJECTS = 200


def _ref(external_id: str) -> dict[str, str]:
    return {"provider": "todoist", "external_id": external_id}


def _todoist_id(ref: dict[str, Any] | None) -> str:
    if not ref or ref.get("provider") != "todoist":
        raise todoist.PlusError("BAD_REQUEST")
    return plus.check_id(ref.get("external_id", ""))


def _task_ids(request: dict[str, Any], *, least: int = 0) -> list[str]:
    ids = request.get("task_ids", [])
    if not least <= len(ids) <= MAX_TASKS or len(set(ids)) != len(ids):
        raise todoist.PlusError("BAD_REQUEST")
    return [plus.check_id(task_id) for task_id in ids]


def _settings_answer(settings: MailSettings) -> dict[str, Any]:
    answer: dict[str, Any] = {
        "categories": [
            {"id": str(category.id), "label": _ref(category.label_id), "priority": WIRE_PRIORITIES[category.priority]}
            for category in settings.categories
        ],
        "etag": settings.etag,
    }
    if settings.destination:
        answer["destination"] = _ref(settings.destination)
    return answer


def _inbox(core: Any) -> str:
    inbox = var(core.env, "TODOIST_DEFAULT_PROJECT_ID")
    if not inbox:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    return inbox


# ---- reads ----------------------------------------------------------------------------------------------------


async def lookup(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """LookupMailItems: one D1 batch, no Todoist call."""
    db, ids = core.env.DB, _task_ids(request)
    rows, *saved = await db.batch(
        [db.prepare(sql.ITEMS.sql).bind(json.dumps(ids), source_id(core.env)), *plan_store.mail_settings_statements(db)]
    )
    items = [
        {
            "id": row["event_id"],
            "task": _ref(row["task_id"]),
            "brief": row["brief"] or mailbox.brief_of(row["head"] or ""),
            "receive_time": rfc3339(int(row["received_at"])),
            "has_summary": bool(row["has_summary"]),
        }
        for row in (dict(item) for item in rows.results)
    ]
    settings = _settings_answer(plan_store.mail_settings_of(*saved))
    answer = {"items": items, "categories": settings["categories"], "categories_etag": settings["etag"]}
    if "destination" in settings:
        answer["destination"] = settings["destination"]
    return answer


async def read_summary(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ReadMailSummary: one primary-key read of the summary Todofy keeps; empty when there is none."""
    row = await core.env.DB.prepare(sql.SUMMARY.sql).bind(plus.check_id(request.get("id", ""))).first()
    return {"summary": dict(row)["summary"] if row is not None else ""}


async def _projects(core: Any) -> list[dict[str, Any]]:
    """The projects filed mail may go to: the Inbox first, then the active ones in Todoist's order, never the mail
    project. Names are only passed on, never stored."""
    inbox = var(core.env, "TODOIST_DEFAULT_PROJECT_ID")
    projects = [
        {"id": str(row["id"]), "display_name": str(row.get("name") or ""), "inbox": bool(row.get("inbox_project"))}
        for row in await todoist.projects(core)
        if row.get("id") and not row.get("is_archived") and not row.get("is_deleted") and str(row["id"]) != inbox
    ]
    return sorted(projects, key=lambda project: not project["inbox"])[:MAX_PROJECTS]


async def read_settings(core: Any) -> dict[str, Any]:
    """ReadMailSettings: D1 and one Todoist read of the projects."""
    settings = await plan_store.mail_settings(core.env.DB)
    return {**_settings_answer(settings), "projects": await _projects(core)}


# ---- writes ---------------------------------------------------------------------------------------------------


async def update_settings(core: Any, request: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """UpdateMailSettings: the whole set in one D1 batch, by etag; the saved settings sent again are a replay.

    Each label must be a current one a category may use (core/plus.mail_label), the destination an active project
    other than the mail project; a label or project gone since the owner chose it is ACTION_NOT_ALLOWED."""
    db = core.env.DB
    requested = []
    for category in request.get("categories", []):
        priority = PRIORITIES.get(category.get("priority", ""))
        if priority is None:
            raise todoist.PlusError("BAD_REQUEST")
        requested.append((_todoist_id(category.get("label")), priority))
    destination = _todoist_id(request.get("destination"))
    settings = await plan_store.mail_settings(db)
    if [(c.label_id, c.priority) for c in settings.categories] == requested and settings.destination == destination:
        return _settings_answer(settings)
    if request.get("etag") != settings.etag:
        raise todoist.PlusError("ETAG_MISMATCH")
    labels = {label["id"]: label for label in current["available_labels"]}
    if any(
        label_id not in labels or not plus.mail_label(labels[label_id], current["labels"]) for label_id, _ in requested
    ):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if destination not in {project["id"] for project in await _projects(core)}:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    saved, archived = mailbox.replace_categories(
        list(settings.categories),
        [(label_id, labels[label_id]["label"], priority) for label_id, priority in requested],
        await plan_store.next_category_id(db),
    )
    updated = MailSettings(tuple(saved), destination)
    await plan_store.save_mail_settings(db, settings, updated, archived, now_s())
    return _settings_answer(updated)


async def _filing(
    core: Any, request: dict[str, Any], current: dict[str, Any], task: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """FileMailItem's two Sync commands, from the categories, the label, the destination and the task as they are
    now. ``task``: the one a retry has just read, whose etag its own first try may have changed."""
    request_id, task_id = request["request_id"], plus.check_id(request.get("task_id", ""))
    settings = await plan_store.mail_settings(core.env.DB)
    if request.get("categories_etag") != settings.etag:
        raise todoist.PlusError("ETAG_MISMATCH")
    category = next((c for c in settings.categories if str(c.id) == request.get("category_id")), None)
    if category is None:
        raise todoist.PlusError("BAD_REQUEST")
    label = next((label for label in current["available_labels"] if label["id"] == category.label_id), None)
    if label is None or not plus.mail_label(label, current["labels"]) or not settings.destination:
        # Todoist would create a label for a name it does not know; Plus never creates one.
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if settings.destination not in {project["id"] for project in await _projects(core)}:
        # Archived or deleted since the owner chose it: the Mailbox opens the categories to choose again.
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if task is None:
        task = await todoist.task(core, task_id)
        if request.get("etag") != plus.task_etag(task, current["labels"]):
            raise todoist.PlusError("ETAG_MISMATCH")
    if str(task.get("project_id") or "") != _inbox(core) or task.get("parent_id"):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    labels = plus.filed_labels(task, label["label"], current["labels"])
    update = {"id": task_id, "labels": labels, "priority": plus.api_priority(category.priority)}
    move = {"id": task_id, "project_id": settings.destination}
    return [
        {"type": "item_update", "uuid": plus.command_id(request_id, 0), "args": update},
        {"type": "item_move", "uuid": plus.command_id(request_id, 1), "args": move},
    ]


async def file(core: Any, request: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """FileMailItem: one Sync under its receipt, then the task read again; a done receipt reads the task alone.

    A started receipt reads the task first. Once it has left the mail project the filing is done. Otherwise the
    frozen commands go again (Todoist runs each UUID once) only if the task, the category's label and the
    destination as they are now build the same ones: a label renamed or added since, or a binding changed, is
    ETAG_MISMATCH, so a retry never writes a label name Todoist no longer has nor drops one the owner added."""
    request_id = request["request_id"]
    digest = plus.fingerprint(["FileMailItem", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise todoist.PlusError("BAD_REQUEST")
    if previous is None:
        commands = await _filing(core, request, current)
    elif previous.result is not None:
        commands = None
    else:
        if previous.plan_etag != current["etag"]:
            raise todoist.PlusError("ETAG_MISMATCH")
        task = await todoist.task(core, request["task_id"])
        if str(task.get("project_id") or "") != _inbox(core):
            receipts.finish(core.sql, request_id, {"task_id": request["task_id"]})
            return {"task": plus.task_view(task, current["today"], current["labels"])}
        if await _filing(core, request, current, task) != previous.commands:
            raise todoist.PlusError("ETAG_MISMATCH")
        commands = previous.commands
    if commands is not None:
        await receipts.start(core, request_id, "FileMailItem", digest, commands, current["etag"])
        await todoist.commands(core, commands)
    task = await todoist.task(core, request["task_id"])
    if commands is not None:
        receipts.finish(core.sql, request_id, {"task_id": request["task_id"]})
    return {"task": plus.task_view(task, current["today"], current["labels"])}


async def _deletions(core: Any, ids: list[str]) -> tuple[set[str], set[str]]:
    """From a fresh read of the mail project: which of ``ids`` may be deleted, and which it does not hold (moved
    elsewhere, or no longer active). Deletable are the active top-level mail tasks the owner has not touched in
    Todoist (core/plus.untouched) that no dependency names and no unfinished Plus write changes (a started receipt,
    whose label, step or move may not be in Todoist yet)."""
    db, inbox = core.env.DB, _inbox(core)
    tasks = {str(task["id"]): task for task in await todoist.project_tasks(core, inbox)}
    parents = {str(task["parent_id"]) for task in tasks.values() if task.get("parent_id")}
    bound = json.dumps(ids)
    mail, linked = await db.batch(
        [db.prepare(sql.MAIL_TASKS.sql).bind(bound), db.prepare(sql.LINKED_TASKS.sql).bind(bound)]
    )
    mail_ids = {str(dict(row)["task_id"]) for row in mail.results}
    linked_ids = {str(dict(row)["task_id"]) for row in linked.results}
    writing = receipts.writing(core.sql, ids)
    deletable = {
        task_id
        for task_id in ids
        if (task := tasks.get(task_id)) is not None
        and str(task.get("project_id") or "") == inbox
        and not task.get("parent_id")
        and task_id in mail_ids
        and task_id not in linked_ids
        and task_id not in writing
        and plus.untouched(task, parents)
    }
    return deletable, set(ids) - set(tasks)


async def delete(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """DeleteMailItems: the deletable tasks are chosen from a fresh read and their item_delete commands frozen in
    the receipt before any is sent, at most SYNC_COMMANDS a Sync (ITEM_NOT_FOUND counts as done).

    A repeat of a started one reads the frozen tasks again and sends only those still deletable, with their frozen
    UUIDs: one the owner changed since stays (Todoist would delete a new step with its parent), and no task is ever
    added, so the batch first chosen bounds every deletion and none is deleted twice. One confirming read must find
    none of those sent still active, or the answer is UNAVAILABLE and the same request finishes the rest. A listed
    task the reads find nowhere is gone already (deleted elsewhere, or by a request whose answer was lost) and
    counts as deleted. The deleted mail's summaries go with it (FORGET); the receipt keeps only the indexes of the
    tasks kept."""
    request_id, ids = request["request_id"], _task_ids(request, least=1)
    digest = plus.fingerprint(["DeleteMailItems", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise todoist.PlusError("BAD_REQUEST")
    if previous is not None and previous.result is not None:
        kept = {ids[index] for index in previous.result["kept"]}
    else:
        if previous is None:
            deletable, absent = await _deletions(core, ids)
            commands = [
                {"type": "item_delete", "uuid": plus.command_id(request_id, index), "args": {"id": task_id}}
                for index, task_id in enumerate(ids)
                if task_id in deletable
            ]
            await receipts.start(core, request_id, "DeleteMailItems", digest, commands)
        else:
            frozen = [command["args"]["id"] for command in previous.commands]
            deletable, absent = await _deletions(core, frozen)
            commands = [command for command in previous.commands if command["args"]["id"] in deletable]
        for offset in range(0, len(commands), todoist.SYNC_COMMANDS):
            await todoist.commands(core, commands[offset : offset + todoist.SYNC_COMMANDS], gone_ok=True)
        sent = [command["args"]["id"] for command in commands]
        active = await todoist.active_ids(core, [*sent, *sorted(absent)])
        if active & set(sent):
            raise todoist.PlusError("UNAVAILABLE")
        deleted = set(sent) | (absent - active)
        kept = set(ids) - deleted
        if deleted:
            await core.env.DB.prepare(sql.FORGET.sql).bind(json.dumps(sorted(deleted))).run()
        receipts.finish(core.sql, request_id, {"kept": [index for index, task_id in enumerate(ids) if task_id in kept]})
        print(json.dumps({"plus": "mail_deleted", "deleted": len(deleted), "kept": len(kept)}))
    return {
        "deleted_task_ids": [task_id for task_id in ids if task_id not in kept],
        "kept_task_ids": [task_id for task_id in ids if task_id in kept],
    }
