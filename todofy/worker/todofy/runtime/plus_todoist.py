"""The Plus API's bounded official Todoist reads and idempotent Sync commands."""

import json
from typing import Any
from urllib.parse import urlencode

from todofy.runtime.config import flag, var
from todofy.runtime.interop import fetch_with_timeout, now_s


class PlusError(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


async def call(core: Any, path: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
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
        raise PlusError("NOT_FOUND")
    if result.status in (401, 403):
        core.block_todoist(now_s())
        raise PlusError("ACTION_NOT_ALLOWED")
    if not result.outcome().ok:
        raise PlusError(
            "UNAVAILABLE"
            if result.status is None or result.status == 429 or result.status >= 500
            else "ACTION_NOT_ALLOWED"
        )
    try:
        value = json.loads(result.body)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, TypeError) as error:
        raise PlusError("UNAVAILABLE") from error


async def metadata(core: Any) -> dict[str, Any]:
    result = await call(core, "/api/v1/sync", {"sync_token": "*", "resource_types": ["user", "labels", "filters"]})
    # The user object includes credentials and personal information. Return only the one needed field.
    timezone = (result.get("user") or {}).get("tz_info", {}).get("timezone")
    if not isinstance(timezone, str) or not timezone:
        raise PlusError("UNAVAILABLE")
    labels, filters = result.get("labels"), result.get("filters")
    if not isinstance(labels, list) or not isinstance(filters, list) or len(labels) > 500 or len(filters) > 500:
        raise PlusError("UNAVAILABLE")
    return {"timezone": timezone, "labels": labels, "filters": filters}


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


async def commands(core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
    response = await call(core, "/api/v1/sync", {"commands": commands, "resource_types": []})
    status = response.get("sync_status", {})
    if any(status.get(command["uuid"]) != "ok" for command in commands):
        # Partial batches are replayed with the exact command UUIDs; succeeded commands do not run twice.
        raise PlusError("ACTION_NOT_ALLOWED")
    return response
