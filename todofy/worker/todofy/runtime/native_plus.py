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


async def commands(core: Any, operations: list[dict[str, Any]], *, gone_ok: bool = False) -> dict[str, Any]:
    if len(operations) > MAX_OPERATIONS:
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
            # Old unfinished journal rows keep their exact Task body; only their local state representation changes.
            state = planning.get("state")
            if state is None:
                state = native_plan.state_from_labels(planning["labels"])
            await native_plan.check_revision(core.env, task_id, planning["expected_rev"], request_id)
        try:
            result = (
                {"id": task_id}
                if not method or (method == "UpdateTask" and not payload.get("update_mask") and planning is not None)
                else await native_tasks.call(core.env, method, payload)
            )
        except native_tasks.NativeTasksError as error:
            if not (gone_ok and method == "DeleteTask" and error.status == 404):
                raise
            result = {}
        task_id = result.get("id", task_id)
        if planning is not None:
            await native_plan.save_fields(core.env, task_id, state, planning["expected_rev"], request_id)
        core.sql.exec(
            "UPDATE native_task_requests SET task_id=?,finished=1,body='{}' WHERE request_id=?", task_id, request_id
        )
        task_ids.append(task_id)
    return {"task_ids": task_ids}


async def resume(core: Any, frozen: list[dict[str, Any]], *, gone_ok: bool = False) -> dict[str, Any]:
    """Only started receipts may resume old Sync envelopes; all new writers use method/body directly."""
    if not frozen or "type" not in frozen[0]:
        return await commands(core, frozen, gone_ok=gone_ok)
    from todofy.runtime.native_plus_legacy import convert

    operations, old = await convert(core, frozen)
    result = await commands(core, operations, gone_ok=gone_ok)
    return {
        "temp_id_mapping": {
            operation["temp_id"]: task_id
            for operation, task_id in zip(old, result["task_ids"], strict=True)
            if "temp_id" in operation
        }
    }
