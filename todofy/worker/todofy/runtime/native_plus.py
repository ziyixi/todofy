"""Native requests for the existing Plus operations, frozen before each Tasks call.

The original Plus receipt still owns the user action. This small request map keeps the exact etag and
body of each native call so a lost response replays the same request, even after another task edit.
"""

import json
import uuid
from typing import Any

from todofy.runtime import native_tasks

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS native_task_requests (request_id TEXT PRIMARY KEY, method TEXT NOT NULL,"
    " body TEXT NOT NULL, task_id TEXT, finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0,1)))"
)
MAX_OPERATIONS = 200


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _operations(commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One native request per task; a mailbox label change and move become one update."""
    operations: list[dict[str, Any]] = []
    for command in commands:
        kind, args = command["type"], command["args"]
        if kind == "item_reorder":
            for item in args["items"]:
                operations.append(
                    {
                        "type": "item_update",
                        "uuid": str(uuid.uuid5(uuid.UUID(command["uuid"]), item["id"])),
                        "args": {"id": item["id"], "child_order": item["child_order"]},
                        "_native_etag": command.get("_native_etags", {}).get(item["id"]),
                    }
                )
        elif (
            kind == "item_move"
            and operations
            and operations[-1]["type"] == "item_update"
            and operations[-1]["args"]["id"] == args["id"]
        ):
            previous = operations[-1]
            operations[-1] = {**previous, "args": {**previous["args"], **args, "section_id": "", "parent_id": ""}}
        elif kind in {"item_add", "item_update", "item_move", "item_close", "item_delete"}:
            operations.append(command)
        else:
            raise native_tasks.NativeTasksError(400)
    if len(operations) > MAX_OPERATIONS:
        raise native_tasks.NativeTasksError(400)
    return operations


def _fields(args: dict[str, Any], labels: dict[str, str]) -> dict[str, Any]:
    fields = {}
    names = {
        "content": "title",
        "description": "description",
        "project_id": "project_id",
        "section_id": "section_id",
        "parent_id": "parent_id",
        "child_order": "sort_order",
    }
    for source, target in names.items():
        if source in args:
            fields[target] = args[source] or (0 if target == "sort_order" else "")
    if "labels" in args:
        if any(label not in labels for label in args["labels"]):
            raise native_tasks.NativeTasksError(409)
        fields["label_ids"] = [labels[label] for label in args["labels"]]
    if "priority" in args:
        fields["priority"] = 5 - int(args["priority"])
    if "deadline" in args:
        fields["deadline"] = (args["deadline"] or {}).get("date", "")
    if "duration" in args:
        duration = args["duration"] or {}
        if duration and duration.get("unit") not in {"minute", "day"}:
            raise native_tasks.NativeTasksError(400)
        fields["duration_minutes"] = int(duration.get("amount", 0)) * (480 if duration.get("unit") == "day" else 1)
    return fields


def _request(operation: dict[str, Any], labels: dict[str, str]) -> tuple[str, dict[str, Any]]:
    kind, args = operation["type"], operation["args"]
    request_id = operation["uuid"]
    if kind == "item_add":
        return "CreateTask", {"task": _fields(args, labels), "task_id": operation["temp_id"], "request_id": request_id}
    etag = operation.get("_native_etag")
    if not etag:
        # A started Todoist receipt cannot become a new native write at cutover.
        raise native_tasks.NativeTasksError(409)
    name = f"tasks/{args['id']}"
    if kind in {"item_close", "item_delete"}:
        return ("CompleteTask" if kind == "item_close" else "DeleteTask"), {
            "name": name,
            "etag": etag,
            "request_id": request_id,
        }
    fields = _fields(args, labels)
    if kind == "item_move":
        fields.update(section_id="", parent_id="")
    return "UpdateTask", {
        "task": {"name": name, **fields},
        "etag": etag,
        "update_mask": ",".join(fields),
        "request_id": request_id,
    }


async def commands(core: Any, commands: list[dict[str, Any]], *, gone_ok: bool = False) -> dict[str, Any]:
    operations = _operations(commands)
    # Bound is checked before the first write. Every operation uses one internal Tasks call; no external fetch.
    catalog = await native_tasks.catalog(core.env) if any("labels" in op["args"] for op in operations) else {}
    labels = {row["title"]: row["id"] for row in catalog.get("labels", [])}
    mapping: dict[str, str] = {}
    for operation in operations:
        request_id = operation["uuid"]
        saved = core.sql.exec(
            "SELECT method,body,task_id,finished FROM native_task_requests WHERE request_id=?", request_id
        ).toArray()
        if saved:
            row = saved[0]
            if row.finished:
                if "temp_id" in operation:
                    mapping[operation["temp_id"]] = row.task_id
                continue
            method, body = row.method, json.loads(row.body)
        else:
            method, body = _request(operation, labels)
            core.sql.exec(
                "INSERT INTO native_task_requests(request_id,method,body) VALUES (?,?,?)",
                request_id,
                method,
                _json(body),
            )
            await core.ctx.storage.sync()
        try:
            result = await native_tasks.call(core.env, method, body)
        except native_tasks.NativeTasksError as error:
            if not (gone_ok and method == "DeleteTask" and error.status == 404):
                raise
            result = {}
        task_id = result.get("id", operation["args"].get("id", ""))
        core.sql.exec(
            "UPDATE native_task_requests SET task_id=?,finished=1,body='{}' WHERE request_id=?", task_id, request_id
        )
        if "temp_id" in operation:
            mapping[operation["temp_id"]] = task_id
    return {"temp_id_mapping": mapping}


def etag(task: dict[str, Any]) -> dict[str, str]:
    """Add only the native source revision; legacy Todoist commands stay byte-for-byte unchanged."""
    value = task.get("_native_etag")
    return {"_native_etag": value} if value else {}


def comparable(commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Native transport revisions are independent from the existing logical retry comparison."""
    return [{key: value for key, value in command.items() if not key.startswith("_native_")} for command in commands]
