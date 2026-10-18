"""The Plus API's reads and writes of the Tasks store, with Tasks' failures as PlusService reasons."""

from typing import Any

from todofy.core import native_task_view, plan
from todofy.runtime import native_plus, native_tasks

# The provider of every task ID the planning store keeps (plan_store: external_id with its provider).
PROVIDER = "tasks"
# The task IDs one read of the open tasks (active) may name.
ACTIVE_READ = 200

# Tasks' own reasons that Plan and Mail can explain better than the HTTP status alone. Tasks answers 400 for
# both BAD_REQUEST and PRECONDITION_FAILED, and 409 for both ETAG_MISMATCH and ALREADY_EXISTS (a reused ID).
NATIVE_REASONS = {
    "BAD_REQUEST": "BAD_REQUEST",
    "PRECONDITION_FAILED": "ACTION_NOT_ALLOWED",
    "ALREADY_EXISTS": "ACTION_NOT_ALLOWED",
}


class PlusError(Exception):
    def __init__(self, reason: str, status: int | None = None) -> None:
        self.reason = reason
        self.status = status  # Tasks' HTTP status when it answered
        super().__init__(reason)


async def native(awaitable: Any) -> Any:
    """``awaitable``'s value; a Tasks failure becomes a PlusError with the reason Plan shows."""
    try:
        return await awaitable
    except native_tasks.NativeTasksError as error:
        reason = (
            "UNAVAILABLE"
            if error.status >= 500
            else NATIVE_REASONS.get(error.reason)
            or {404: "NOT_FOUND", 409: "ETAG_MISMATCH"}.get(error.status, "ACTION_NOT_ALLOWED")
        )
        raise PlusError(reason, error.status) from error


async def metadata(core: Any) -> dict[str, Any]:
    """The account's timezone, labels and filters, from one Tasks catalog read."""
    return native_task_view.metadata(await native(native_tasks.catalog(core.env)))


async def tasks(core: Any, limit: int = 100, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
    """One page of open tasks."""
    return await native(native_tasks.page(core.env, cursor=cursor, limit=limit))


async def task(core: Any, task_id: str) -> dict[str, Any]:
    return await native(native_tasks.task(core.env, task_id))


async def active(core: Any, task_ids: list[str]) -> dict[str, dict[str, Any]]:
    """The open tasks among ``task_ids`` (at most ACTIVE_READ), by ID. An incomplete answer raises: a task
    missing from it would look closed."""
    result: dict[str, dict[str, Any]] = {}
    for start in range(0, len(task_ids), 100):
        page, following = await native(native_tasks.page(core.env, ids=task_ids[start : start + 100]))
        if following:
            raise PlusError("UNAVAILABLE")
        result.update({item["id"]: item for item in page})
    return result


async def closed_as(core: Any, task_id: str) -> str | None:
    """How a task no longer listed as open closed: 'completed', 'deleted' (Tasks no longer has it), or None when
    it is open again."""
    try:
        current = await task(core, task_id)
    except PlusError as error:
        if error.reason == "NOT_FOUND":
            return plan.DELETED
        raise
    return plan.COMPLETED if current.get("checked") else None


async def commands(core: Any, operations: list[dict[str, Any]]) -> dict[str, Any]:
    """The frozen Tasks operations of one receipt (runtime/native_plus.py), each run at most once."""
    return await native(native_plus.commands(core, operations))
