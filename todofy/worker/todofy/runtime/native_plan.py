"""Native planning state; canonical role strings exist only inside the existing pure planning rules."""

import json
from typing import Any

from todofy.core import plus
from todofy.core.gtd import parse_instant, rfc3339
from todofy.core.native_plan import CANONICAL_MAPPING as CANONICAL_MAPPING
from todofy.core.native_plan import FLAG_NAMES as FLAG_NAMES
from todofy.core.native_plan import ROLE_NAMES as ROLE_NAMES
from todofy.core.native_plan import labels_from_state as labels_from_state
from todofy.core.native_plan import state_from_labels as state_from_labels
from todofy.core.sql import native_plan as sql


async def ready(env: Any) -> bool:
    row = await env.DB.prepare(sql.READY.sql).first()
    return row is not None and json.loads(dict(row)["value"]).get("initialized") is True


async def read_overlay(env: Any, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not tasks:
        return []
    result = await env.DB.prepare(sql.READ.sql).bind(json.dumps([task["id"] for task in tasks])).all()
    states = {row["external_id"]: row for row in (dict(item) for item in result.results)}
    overlaid = []
    for task in tasks:
        state = states.get(task["id"], {})
        planning = {
            **state_from_labels([]),
            **{key: bool(state[key]) if key in FLAG_NAMES else state[key] for key in sql.FIELDS if key in state},
        }
        if planning["quick"]:
            planning["task"] = True
        content_labels = list(task.get("_native_content_labels", task.get("labels") or []))
        labels = sorted((set(content_labels) - ROLE_NAMES) | set(labels_from_state(planning)))
        updated = task.get("updated_at")
        if state.get("updated_at", 0) > (parse_instant(updated) or 0):
            updated = rfc3339(state["updated_at"])
        overlaid.append(
            {
                **task,
                "labels": labels,
                "updated_at": updated,
                "_native_planning": True,
                "_native_plan_rev": int(state.get("rev", 0)),
                "_native_content_labels": content_labels,
                "_native_plan_state": planning,
            }
        )
    return overlaid


async def check_revision(env: Any, task_id: str, expected_rev: int, request_id: str) -> None:
    from todofy.runtime.native_tasks import NativeTasksError

    current = await env.DB.prepare(sql.GET.sql).bind(task_id).first()
    row = dict(current) if current is not None else {}
    if int(row.get("rev", 0)) != expected_rev and row.get("request_id") != request_id:
        raise NativeTasksError(409)


async def save_fields(env: Any, task_id: str, state: dict[str, Any], expected_rev: int, request_id: str) -> int:
    """Call under plus_lock, with the state, revision and ID frozen by the existing command receipt."""
    from todofy.runtime.interop import now_s
    from todofy.runtime.native_tasks import NativeTasksError

    if not isinstance(expected_rev, int) or expected_rev < 0 or not request_id or len(request_id) > 100:
        raise NativeTasksError(400)
    plus.check_id(task_id)
    if set(state) != set(sql.FIELDS):
        raise NativeTasksError(400)
    now = now_s()
    values = [int(state[field]) if field in FLAG_NAMES else state[field] for field in sql.FIELDS]
    result = await env.DB.batch(
        [
            env.DB.prepare(sql.REGISTER.sql).bind(task_id, now),
            env.DB.prepare(sql.SAVE.sql).bind(*values, request_id, now, task_id, expected_rev, expected_rev),
        ]
    )
    written = next((dict(row) for row in result[1].results), None)
    if written is not None:
        return int(written["rev"])
    current = await env.DB.prepare(sql.GET.sql).bind(task_id).first()
    if current is not None and dict(current)["request_id"] == request_id:
        return int(dict(current)["rev"])
    raise NativeTasksError(409)
