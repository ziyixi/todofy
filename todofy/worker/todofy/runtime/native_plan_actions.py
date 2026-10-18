"""Native planning actions build Tasks protobuf requests and separate planning-state changes."""

from datetime import date
from typing import Any

from todofy.core import native_plan, plus
from todofy.runtime import native_tasks
from todofy.runtime.plus_todoist import PlusError, _native


async def build(core: Any, method: str, request: dict[str, Any]) -> list[dict[str, Any]]:
    task_id = plus.check_id(request.get("task_id") or request.get("parent_id", ""))
    task = await _native(native_tasks.task(core.env, task_id))
    request_id = request["request_id"]
    if method == "CompleteTask":
        if (flow_date := request.get("flow_date")) and date.fromisoformat(flow_date).isoformat() != flow_date:
            raise PlusError("BAD_REQUEST")
        return [
            {
                "method": "CompleteTask",
                "body": {
                    "name": f"tasks/{task_id}",
                    "etag": task["_native_etag"],
                    "request_id": plus.command_id(request_id),
                },
            }
        ]
    if method == "AppendTaskSteps":
        steps = request.get("steps", [])
        if not 1 <= len(steps) <= 20:
            raise PlusError("BAD_REQUEST")
        operations = []
        for index, step in enumerate(steps):
            title, estimate = step["title"].strip(), step.get("estimated_minutes")
            if not 1 <= len(title) <= 500 or (estimate is not None and not 1 <= estimate <= 10080):
                raise PlusError("BAD_REQUEST")
            # Tasks inherits the actual parent's project; no Inbox projection is written back as a project.
            child = {"title": title, "parent_id": task_id}
            if estimate is not None:
                child["duration_minutes"] = estimate
            operations.append(
                {
                    "method": "CreateTask",
                    "body": {
                        "task": child,
                        "task_id": plus.command_id(request_id, index + 100),
                        "request_id": plus.command_id(request_id, index),
                    },
                }
            )
        return operations
    if request.get("etag") != plus.task_etag(task, native_plan.CANONICAL_MAPPING):
        raise PlusError("ETAG_MISMATCH")
    state = task["_native_plan_state"]
    operation = {"method": "", "body": {"name": f"tasks/{task_id}", "request_id": plus.command_id(request_id)}}
    if method == "SetTaskPlan":
        state = native_plan.apply_plan(state, request)
    elif method == "SetTaskLead":
        deadline = request.get("deadline", "")
        state = native_plan.apply_lead(state, deadline, request.get("lead_days", 0))
        if deadline != (task.get("deadline") or {}).get("date", ""):
            operation = {
                "method": "UpdateTask",
                "body": {
                    "task": {"name": f"tasks/{task_id}", "deadline": deadline},
                    "etag": task["_native_etag"],
                    "request_id": plus.command_id(request_id),
                    "update_mask": "deadline",
                },
            }
    else:
        raise PlusError("BAD_REQUEST")
    operation["planning"] = {"state": state, "expected_rev": task["_native_plan_rev"]}
    return [operation]
