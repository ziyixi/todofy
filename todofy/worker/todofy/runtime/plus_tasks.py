"""Mail's reads and writes of the Tasks store, with Tasks' failures as PlusService reasons."""

from typing import Any

from todofy.core import native_task_view
from todofy.runtime import native_tasks

# The provider of every task and label ID Mail names (ExternalRef.provider).
PROVIDER = "tasks"

# Tasks' own reasons that Mail can explain better than the HTTP status alone. Tasks answers 400 for both
# BAD_REQUEST and PRECONDITION_FAILED, and 409 for both ETAG_MISMATCH and ALREADY_EXISTS (a reused ID).
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
    """``awaitable``'s value; a Tasks failure becomes a PlusError with the reason Mail shows."""
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


async def labels(core: Any) -> dict[str, str]:
    """The owner's labels in Tasks, their names by ID, from one catalog read."""
    catalog = native_task_view.metadata(await native(native_tasks.catalog(core.env)))
    return {label["id"]: label["name"] for label in catalog["labels"]}


async def task(core: Any, task_id: str) -> dict[str, Any]:
    return await native(native_tasks.task(core.env, task_id))


async def commands(core: Any, operations: list[dict[str, Any]]) -> dict[str, Any]:
    """The frozen Tasks operations of one receipt (runtime/plus_receipts.py), in order, and their tasks' IDs. Each
    carries a request ID derived from the receipt's (core/mailbox.command_id), which Tasks keeps with its first
    answer: sending one again after a lost answer replays that answer instead of writing twice. A receipt started
    while Todoist was still a store holds Sync envelopes ("type"), which are refused."""
    if any("type" in operation for operation in operations):
        raise PlusError("ACTION_NOT_ALLOWED")
    task_ids = []
    for operation in operations:
        answer = await native(native_tasks.call(core.env, operation["method"], operation["body"]))
        task_ids.append(str(answer["id"]))
    return {"task_ids": task_ids}
