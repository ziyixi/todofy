"""Tasks' protobuf boundary, reached only through the private service binding."""

import json
import uuid
from typing import Any

from ziyixi_proto.tasks.ui.v1 import tasks_ui_service_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from todofy.core import native_task_view
from todofy.runtime import native_plan
from todofy.runtime.config import var


class NativeTasksError(Exception):
    def __init__(self, status: int, *, uncertain: bool = False) -> None:
        self.status = status
        self.uncertain = uncertain
        super().__init__("NATIVE_TASKS_UNAVAILABLE" if status >= 500 else "NATIVE_TASKS_REJECTED")


def enabled(env: Any) -> bool:
    return var(env, "TASK_SOURCE") == "tasks"


def request_id(value: str) -> str:
    """Keep UUID action identities; map frozen legacy mail IDs without altering their ledger rows."""
    if not value:
        raise ValueError("Missing frozen task request ID")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        parsed = None
    if parsed is not None and parsed.version in (4, 5):
        return str(parsed)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"todofy-tasks:{value}"))


async def call(env: Any, method: str, body: dict[str, Any]) -> dict[str, Any]:
    binding = next((item for item in pb.HTTP_BINDINGS if item.rpc == method), None)
    if binding is None:
        raise ValueError("unsupported native task operation")
    message = from_wire(binding.request, body, strict=True).message
    service = getattr(env, "TASKS", None)
    if service is None:
        raise NativeTasksError(503)
    # No fallback: a failed native write cannot be repeated against the old Todoist account.
    try:
        result = await service.call(method, json.dumps(to_wire(message), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        raise NativeTasksError(503, uncertain=True) from error
    if result.status >= 400:
        raise NativeTasksError(result.status)
    try:
        value = json.loads(result.body)
        if binding.response is type(None):
            if value != {}:
                raise ValueError("Invalid Empty response")
            return {}
        response = from_wire(binding.response, value, strict=False).message
    except (TypeError, ValueError) as error:
        raise NativeTasksError(502, uncertain=True) from error
    return to_wire(response)


async def catalog(env: Any) -> dict[str, Any]:
    return await call(env, "GetCatalog", {"name": "catalog"})


async def task(env: Any, task_id: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    source = metadata if metadata is not None else await catalog(env)
    row = await call(env, "GetTask", {"name": f"tasks/{task_id}"})
    return (await native_plan.read_overlay(env, [native_task_view.task(row, source)]))[0]


async def page(
    env: Any,
    *,
    cursor: str = "",
    limit: int = 100,
    project_id: str = "",
    metadata: dict[str, Any] | None = None,
    ids: list[str] | None = None,
    include_description: bool = False,
    query: str = "",
) -> tuple[list[dict[str, Any]], str]:
    source = metadata if metadata is not None else await catalog(env)
    # The all view includes descendants. Project view is intentionally root-only for the UI.
    request: dict[str, Any] = {
        "view": "search" if query else "all",
        "page_size": min(limit, 20 if include_description else 100),
        "page_token": cursor,
        "include_description": include_description,
    }
    if project_id:
        request["project_id"] = project_id
    if ids:
        request["task_ids"] = ids
    if query:
        request["query"] = query
    response = await call(env, "ListTasks", request)
    return await native_plan.read_overlay(
        env, [native_task_view.task(row, source) for row in response.get("tasks", [])]
    ), response.get("next_page_token", "")
