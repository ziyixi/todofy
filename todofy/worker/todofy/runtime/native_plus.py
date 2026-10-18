"""Frozen native Tasks protobuf operations, plus explicit Todofy planning-state CAS."""

import json
from typing import Any

from todofy.runtime import native_plan, native_tasks

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS native_task_requests (request_id TEXT PRIMARY KEY, method TEXT NOT NULL,"
    " body TEXT NOT NULL, task_id TEXT, finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0,1)))"
)
MAX_OPERATIONS = 200


def _task_id(body: dict[str, Any]) -> str:
    return str(body.get("task_id") or body.get("name") or body.get("task", {}).get("name", "")).removeprefix("tasks/")


async def commands(core: Any, operations: list[dict[str, Any]]) -> dict[str, Any]:
    """Each operation once, journalled before it is sent; a repeat of a finished one answers its task ID. A
    receipt started before Tasks was the only store holds Sync envelopes ("type"), which are refused."""
    if len(operations) > MAX_OPERATIONS or any("type" in operation for operation in operations):
        raise native_tasks.NativeTasksError(400)
    task_ids = []
    for operation in operations:
        body = operation["body"]
        request_id = body["request_id"]
        saved = core.sql.exec(
            "SELECT method,body,task_id,finished FROM native_task_requests WHERE request_id=?", request_id
        ).toArray()
        if saved:
            row = saved[0]
            if row.finished:
                task_ids.append(str(row.task_id))
                continue
            method, body = row.method, json.loads(row.body)
        else:
            method = operation["method"]
            body = {**body, **({"_planning": operation["planning"]} if "planning" in operation else {})}
            core.sql.exec(
                "INSERT INTO native_task_requests(request_id,method,body) VALUES (?,?,?)",
                request_id,
                method,
                json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            )
            await core.ctx.storage.sync()
        planning = body.get("_planning")
        payload = {key: value for key, value in body.items() if key != "_planning"}
        task_id = _task_id(payload)
        if planning is not None:
            if "state" not in planning:
                raise native_tasks.NativeTasksError(400)  # a journal row older than the native planning state
            await native_plan.check_revision(core.env, task_id, planning["expected_rev"], request_id)
        result = (
            {"id": task_id}
            if not method or (method == "UpdateTask" and not payload.get("update_mask") and planning is not None)
            else await native_tasks.call(core.env, method, payload)
        )
        task_id = result.get("id", task_id)
        if planning is not None:
            await native_plan.save_fields(core.env, task_id, planning["state"], planning["expected_rev"], request_id)
        core.sql.exec(
            "UPDATE native_task_requests SET task_id=?,finished=1,body='{}' WHERE request_id=?", task_id, request_id
        )
        task_ids.append(task_id)
    return {"task_ids": task_ids}
