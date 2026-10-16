"""The Plus API's bounded official Todoist reads and idempotent Sync commands."""

import json
from typing import Any
from urllib.parse import urlencode

from todofy.core import plan, plus
from todofy.runtime import plus_cache
from todofy.runtime.config import flag, integer, var
from todofy.runtime.interop import fetch_with_timeout, now_s

RESOURCES = ["user", "labels", "filters"]
# How long a read may use the metadata the object synced; a label write always syncs first.
METADATA_MAX_AGE = 5 * 60
# Full Syncs (sync_token "*") the object starts per 15-minute window: Todoist allows 100, shared with every
# other client of the account. A full Sync is needed only when the cache is empty or Todoist refused its token.
FULL_SYNC_WINDOW = 15 * 60
FULL_SYNC_LIMIT = 20
# A client error on an incremental Sync other than authentication (the 6-hour block) and the rate limit.
REFUSED_TOKEN = frozenset(range(400, 500)) - {401, 403, 429}
# The activity log's events that say how a task left the active list; the newest one decides (closed_as).
CLOSING_EVENTS = ("completed", "uncompleted", "deleted")


class PlusError(Exception):
    def __init__(self, reason: str, status: int | None = None) -> None:
        self.reason = reason
        self.status = status  # Todoist's HTTP status when it answered
        super().__init__(reason)


async def call(
    core: Any, path: str, data: dict[str, Any] | None = None, *, forbidden_blocks: bool = True
) -> dict[str, Any]:
    """One Todoist call. A 401, or a 403 unless ``forbidden_blocks`` is False, blocks Todoist calls for six
    hours (core.block_todoist): a read that the account's plan may not allow passes False."""
    env = core.env
    key = var(env, "TODOIST_API_KEY")
    if not key:
        raise PlusError("NOT_CONFIGURED")
    now = now_s()
    if core.todoist_wait(now) is not None:
        raise PlusError("ACTION_NOT_ALLOWED" if flag(env, "FORCE_PAUSE_TODOIST") else "UNAVAILABLE")
    core.count_todoist_calls(1, now)
    headers = {"Authorization": f"Bearer {key}"}
    options: dict[str, Any] = {"method": "GET", "headers": headers}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        options.update(
            method="POST",
            body=urlencode(
                {key: json.dumps(value) if isinstance(value, list) else value for key, value in data.items()}
            ),
        )
    result = await fetch_with_timeout(
        var(env, "TODOIST_API_BASE", "https://api.todoist.com").rstrip("/") + path, timeout_ms=12000, **options
    )
    if result.status == 404:
        raise PlusError("NOT_FOUND", result.status)
    if result.status in (401, 403):
        if result.status == 401 or forbidden_blocks:
            core.block_todoist(now_s())
        raise PlusError("ACTION_NOT_ALLOWED", result.status)
    if not result.outcome().ok:
        raise PlusError(
            "UNAVAILABLE"
            if result.status is None or result.status == 429 or result.status >= 500
            else "ACTION_NOT_ALLOWED",
            result.status,
        )
    try:
        value = json.loads(result.body)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, TypeError) as error:
        raise PlusError("UNAVAILABLE") from error


async def metadata(core: Any, *, fresh: bool = False) -> dict[str, Any]:
    """The account's timezone, labels and the filters Plus replaces.

    From the object's cache when it was synced at most METADATA_MAX_AGE ago and ``fresh`` is not asked for,
    else after one incremental Sync from the cached token; a full Sync only when there is no token. Under
    PLUS_METADATA=full, a full Sync every call, as before the cache.
    """
    if not plus_cache.enabled(core.env):
        answer = await call(core, "/api/v1/sync", {"sync_token": "*", "resource_types": RESOURCES})
        return plus.metadata_view(_merged(None, answer))
    now = now_s()
    cached = plus_cache.get(core.sql, "todoist")
    max_age = integer(core.env, "PLUS_METADATA_MAX_AGE_MS", METADATA_MAX_AGE * 1000) / 1000  # tests shorten it
    if cached is not None and not fresh and now - cached.refreshed_at < max_age:
        return plus.metadata_view(cached.value)
    token = cached.value["sync_token"] if cached is not None else "*"
    if token == "*" and not _take_full_sync(core.sql, now):
        raise PlusError("UNAVAILABLE")
    try:
        answer = await call(core, "/api/v1/sync", {"sync_token": token, "resource_types": RESOURCES})
    except PlusError as error:
        if token != "*" and error.status in REFUSED_TOKEN:
            # Todoist refused the request itself (an expired token, say): the next call starts over in full.
            plus_cache.drop(core.sql, "todoist")
        raise
    full = token == "*" or answer.get("full_sync") is True
    if full and token != "*":
        _take_full_sync(core.sql, now)  # Todoist answered in full: it counts against the same limit
    value = _merged(None if full else cached.value, answer)
    plus_cache.put(core.sql, "todoist", value, now)
    return plus.metadata_view(value)


def _merged(previous: dict[str, Any] | None, answer: dict[str, Any]) -> dict[str, Any]:
    try:
        return plus.merge_metadata(previous, answer)
    except (ValueError, AttributeError, TypeError) as error:
        raise PlusError("UNAVAILABLE") from error


def _take_full_sync(store: Any, now: int) -> bool:
    """Count one full Sync in the current window; False once the window's limit is used up."""
    window = now - now % FULL_SYNC_WINDOW
    counted = plus_cache.get(store, "full_syncs")
    count = counted.value["count"] if counted is not None and counted.value["window"] == window else 0
    if count >= FULL_SYNC_LIMIT:
        return False
    plus_cache.put(store, "full_syncs", {"window": window, "count": count + 1}, now)
    return True


async def tasks(core: Any, limit: int = 200, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
    query: dict[str, Any] = {"limit": limit}
    if cursor:
        query["cursor"] = cursor
    value = await call(core, "/api/v1/tasks?" + urlencode(query))
    result = value.get("results")
    following = value.get("next_cursor") or ""
    if not isinstance(result, list) or len(result) > limit or not isinstance(following, str):
        raise PlusError("UNAVAILABLE")
    return result, following


async def task(core: Any, task_id: str) -> dict[str, Any]:
    return await call(core, "/api/v1/tasks/" + task_id)


async def active(core: Any, task_ids: list[str]) -> dict[str, dict[str, Any]]:
    """The tasks among ``task_ids`` (at most 200) that Todoist lists as active, by ID, in one read. An incomplete
    answer raises: a task missing from it would look closed."""
    value = await call(core, "/api/v1/tasks?" + urlencode({"ids": ",".join(task_ids), "limit": len(task_ids)}))
    result = value.get("results")
    if not isinstance(result, list) or value.get("next_cursor"):
        raise PlusError("UNAVAILABLE")
    wanted = set(task_ids)
    return {str(item["id"]): item for item in result if isinstance(item, dict) and str(item.get("id")) in wanted}


async def closed_as(core: Any, task_id: str) -> str:
    """How a task Todoist no longer lists as active closed: 'completed' when the newest of its completion,
    reopening and deletion events in the activity log is a completion, else 'deleted' (also when the log holds
    none of them, such as after the plan's log retention). Each event names its task, so the answer is filtered
    here too. An account whose plan has no activity log gets a 403, which raises without blocking other calls."""
    query = {
        "object_type": "item",
        "object_id": task_id,
        # The documented form: a JSON array of "object_type:event_type".
        "object_event_types": json.dumps([f"item:{event}" for event in CLOSING_EVENTS]),
        "limit": 20,
    }
    value = await call(core, "/api/v1/activities?" + urlencode(query), forbidden_blocks=False)
    results = value.get("results")
    if not isinstance(results, list):
        raise PlusError("UNAVAILABLE")
    events = [
        event
        for event in results
        if isinstance(event, dict)
        and str(event.get("object_id")) == task_id
        and event.get("event_type") in CLOSING_EVENTS
    ]
    newest = max(events, key=lambda event: str(event.get("event_date") or ""), default=None)
    return plan.COMPLETED if newest is not None and newest["event_type"] == "completed" else plan.DELETED


async def commands(core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
    response = await call(core, "/api/v1/sync", {"commands": commands, "resource_types": []})
    status = response.get("sync_status", {})
    if any(status.get(command["uuid"]) != "ok" for command in commands):
        # Partial batches are replayed with the exact command UUIDs; succeeded commands do not run twice.
        raise PlusError("ACTION_NOT_ALLOWED")
    return response
