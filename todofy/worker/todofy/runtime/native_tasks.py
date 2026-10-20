"""Tasks' protobuf boundary, reached only through the private service binding.

Tasks is the only task store: mail, reminder, review and intent tasks are created here, and a create
whose outcome is unknown is settled by the read-only footer lookup (v2 plan §4.9, §5.3 B/B′). A create
that may have reached Tasks is never resent blindly; a retry sends the same frozen request ID, which
Tasks deduplicates.
"""

import asyncio
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ziyixi_proto.tasks.ui.v1 import tasks_ui_service_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from todofy.core import native_task_view
from todofy.core.backoff import LOOKUP_MAX_PAGES, LOOKUP_PAGE_TIMEOUT
from todofy.core.classify import Failure, HttpOutcome, TaskVerdict, classify_task_create
from todofy.core.render import FOOTER_PREFIX, has_footer
from todofy.core.todoist_request import TaskRequest, matching_task_ids


class NativeTasksError(Exception):
    def __init__(self, status: int, *, uncertain: bool = False, reason: str = "") -> None:
        self.status = status
        self.uncertain = uncertain
        self.reason = reason  # Tasks' ErrorInfo reason, when its answer named one
        super().__init__("NATIVE_TASKS_UNAVAILABLE" if status >= 500 else "NATIVE_TASKS_REJECTED")


def _error_reason(body: str) -> str:
    """The ErrorInfo reason of a Google RPC Status body; empty when it names none."""
    try:
        details = json.loads(body)["error"]["details"]
        return next(
            (str(item["reason"]) for item in details if str(item.get("@type", "")).endswith("google.rpc.ErrorInfo")),
            "",
        )
    except (TypeError, ValueError, KeyError, AttributeError):
        return ""


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
    try:
        result = await service.call(method, json.dumps(to_wire(message), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        raise NativeTasksError(503, uncertain=True) from error
    if result.status >= 400:
        raise NativeTasksError(result.status, reason=_error_reason(result.body))
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
    return await call(env, "GetCatalog", {"name": "catalog", "include_task_counts": False})


async def task(env: Any, task_id: str) -> dict[str, Any]:
    source = await catalog(env)
    return native_task_view.task(await call(env, "GetTask", {"name": f"tasks/{task_id}"}), source)


async def page(
    env: Any,
    *,
    cursor: str = "",
    limit: int = 100,
    metadata: dict[str, Any] | None = None,
    include_description: bool = False,
    query: str = "",
) -> tuple[list[dict[str, Any]], str]:
    source = metadata if metadata is not None else await catalog(env)
    # The all view includes descendants.
    request: dict[str, Any] = {
        "view": "search" if query else "all",
        "page_size": min(limit, 20 if include_description else 100),
        "page_token": cursor,
        "include_description": include_description,
    }
    if query:
        request["query"] = query
    response = await call(env, "ListTasks", request)
    tasks = [native_task_view.task(row, source) for row in response.get("tasks", [])]
    return tasks, response.get("next_page_token", "")


@dataclass(frozen=True, slots=True)
class CreateResult:
    verdict: TaskVerdict  # feed it to the state machine
    task_id: str  # "" unless created
    attempts: int  # CreateTask calls sent (0 or 1)


async def create_task(env: Any, request: TaskRequest, *, budget_ms: int) -> CreateResult:
    """One bounded CreateTask under the frozen request's identity; its outcome classified like any create."""
    if getattr(env, "TASKS", None) is None or budget_ms <= 0:
        return CreateResult(classify_task_create(HttpOutcome(failure=Failure.NOT_SENT), ""), "", 0)
    try:
        source = json.loads(request.body)
        task = {"title": source["content"], "description": source["description"]}
        for name in ("project_id", "parent_id"):
            if source.get(name):
                task[name] = source[name]
        body = {"request_id": request_id(request.headers["X-Request-Id"]), "task": task}
    except (KeyError, TypeError, ValueError):
        return CreateResult(classify_task_create(HttpOutcome(status=400), ""), "", 0)
    try:
        row = await asyncio.wait_for(call(env, "CreateTask", body), timeout=budget_ms / 1000)
    except TimeoutError:
        return CreateResult(classify_task_create(HttpOutcome(failure=Failure.TIMEOUT), ""), "", 1)
    except NativeTasksError as error:
        if error.uncertain:
            outcome = HttpOutcome(failure=Failure.LOST)
        else:
            # A refused binding is an outage of this deployment, never the owner's account: retried later.
            outcome = HttpOutcome(status=503 if error.status in (401, 403) else error.status)
        return CreateResult(classify_task_create(outcome, ""), "", 1)
    task_id = row.get("id", "")
    return CreateResult(classify_task_create(HttpOutcome(status=200), task_id), task_id, 1)


async def find_footer_tasks(env: Any, event_id: str) -> list[str] | None:
    """IDs of open tasks whose description carries the event footer.

    None when the scan failed or did not finish within LOOKUP_MAX_PAGES pages:
    only a complete scan can prove how many tasks exist.
    """
    return await find_tasks(env, lambda description: has_footer(description, event_id), query=FOOTER_PREFIX + event_id)


async def find_tasks(env: Any, matches: Callable[[str], bool], *, query: str = "") -> list[str] | None:
    """IDs of open tasks whose description ``matches`` (a footer test: the mail event's, or a task intent's),
    searched by ``query``; None unless the whole scan finished."""
    found: list[str] = []
    cursor = ""
    try:
        metadata = await asyncio.wait_for(catalog(env), timeout=LOOKUP_PAGE_TIMEOUT)
        for _ in range(LOOKUP_MAX_PAGES):
            tasks, cursor = await asyncio.wait_for(
                page(env, cursor=cursor, limit=20, metadata=metadata, include_description=True, query=query),
                timeout=LOOKUP_PAGE_TIMEOUT,
            )
            ids = matching_task_ids(tasks, matches)
            if not all(ids):
                return None  # a matching task without an id cannot be counted or resolved
            found += [task_id for task_id in ids if task_id not in found]
            if not cursor:
                return found
    except (NativeTasksError, TimeoutError, ValueError):
        return None
    return None
