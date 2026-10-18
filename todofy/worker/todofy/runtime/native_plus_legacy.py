"""Read-side conversion for unfinished native receipts saved before direct Tasks operations."""

import uuid
from typing import Any

from todofy.runtime import native_plan, native_tasks

MAX_OPERATIONS = 200


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
        ordinary = [label for label in args["labels"] if label not in native_plan.ROLE_NAMES]
        if any(label not in labels for label in ordinary):
            raise native_tasks.NativeTasksError(409)
        fields["label_ids"] = [labels[label] for label in ordinary]
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
    if set(args.get("labels", [])) & native_plan.ROLE_NAMES and "_native_plan_rev" not in operation:
        raise native_tasks.NativeTasksError(409)
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
    planning = None
    if "labels" in args and "_native_plan_rev" in operation:
        planning = {
            "labels": [label for label in args["labels"] if label in native_plan.ROLE_NAMES],
            "expected_rev": operation["_native_plan_rev"],
        }
        ordinary = set(args["labels"]) - native_plan.ROLE_NAMES
        if ordinary == set(operation.get("_native_content_labels", [])):
            fields.pop("label_ids", None)
    if kind == "item_move":
        fields.update(section_id="", parent_id="")
    return "UpdateTask", {
        "task": {"name": name, **fields},
        "etag": etag,
        "update_mask": ",".join(fields),
        "request_id": request_id,
        **({"_planning": planning} if planning is not None else {}),
    }


async def convert(core: Any, commands: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    old = _operations(commands)
    catalog = (
        await native_tasks.catalog(core.env)
        if any(set(operation["args"].get("labels", [])) - native_plan.ROLE_NAMES for operation in old)
        else {}
    )
    labels = {row["title"]: row["id"] for row in catalog.get("labels", [])}
    operations = []
    for operation in old:
        method, body = _request(operation, labels)
        planning = body.pop("_planning", None)
        if planning is not None:
            planning = {
                "state": native_plan.state_from_labels(planning["labels"]),
                "expected_rev": planning["expected_rev"],
            }
        if method == "UpdateTask" and not body.get("update_mask") and planning is not None:
            method = ""
            body = {"name": body["task"]["name"], "request_id": body["request_id"]}
        operations.append({"method": method, "body": body, **({"planning": planning} if planning is not None else {})})
    return operations, old
