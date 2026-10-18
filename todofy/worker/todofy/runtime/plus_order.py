"""ReorderTasks, run by plus_api.handle inside plus_lock (docs/planning-api.md, "Bets, dependencies and reordering").

A new order of up to MAX_LANE_TASKS tasks: one Review lane's, kept in the planning store (plan_store.save_lane_order),
or a parent's sub-tasks (no lane). In Tasks only the moved task's siblings among them change, and only in a lane
that does not sort by update time (core/plus.py UNTOUCHED_LANES): they permute their own position slots with one
bounded ReorderTasks operation under a receipt (runtime/plus_receipts.py), which Tasks commits atomically, and none
when nothing changes.

``current`` is the caller's plan (plus_api.require_ready): the label mapping and the account's day.
"""

from typing import Any

from todofy.core import plan as planning
from todofy.core import plus
from todofy.runtime import plan_store, plus_tasks
from todofy.runtime import plus_receipts as receipts
from todofy.runtime.interop import now_s


def _native_updates(found: dict[str, Any], ids: list[str], moved: str, request_id: str) -> list[dict[str, Any]]:
    if moved not in found:
        return []
    selected = found[moved]
    siblings = [
        found[i]
        for i in ids
        if i in found
        and all(found[i].get(field) == selected.get(field) for field in ("project_id", "section_id", "parent_id"))
    ]
    orders = sorted(row["sort_order"] for row in siblings)
    positions = [
        {
            "name": f"tasks/{row['id']}",
            "etag": row["_native_etag"],
            "sort_order": position,
        }
        for row, position in zip(siblings, orders, strict=True)
        if row["sort_order"] != position
    ]
    return (
        [{"method": "ReorderTasks", "body": {"positions": positions, "request_id": plus.command_id(request_id)}}]
        if positions
        else []
    )


async def reorder(core: Any, request: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """ReorderTasks: reads before and after one Tasks operation, plus an optional lane-order save.

    The receipt keeps the frozen ReorderTasks operation, with the etags it was built from, and finishes with no
    result: a repeat of a done one only reads the tasks again (and saves the same lane). A repeat of a started one
    resends its frozen operation, which Tasks runs at most once and refuses (ETAG_MISMATCH) once a sibling changed."""
    ids = request.get("task_ids", [])
    if not 1 <= len(ids) <= planning.MAX_LANE_TASKS or len(set(ids)) != len(ids):
        raise plus_tasks.PlusError("BAD_REQUEST")
    ids = [plus.check_id(task_id) for task_id in ids]
    moved, lane = plus.check_id(request.get("task_id", "")), request.get("lane", "")
    if moved not in ids or lane not in ("", *planning.LANES):
        raise plus_tasks.PlusError("BAD_REQUEST")
    request_id = request["request_id"]
    digest = plus.fingerprint(["ReorderTasks", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise plus_tasks.PlusError("BAD_REQUEST")
    found = await plus_tasks.active(core, ids)
    started = previous is not None and previous.result is None
    if previous is not None and not started:
        commands = []
    elif started:
        commands = previous.commands
    else:
        commands = [] if lane in plus.UNTOUCHED_LANES else _native_updates(found, ids, moved, request_id)
    if commands:
        await receipts.start(core, request_id, "ReorderTasks", digest, commands)
        await plus_tasks.commands(core, commands)
        found = await plus_tasks.active(core, ids)
    answer: dict[str, Any] = {
        "tasks": [plus.task_view(found[i], current["today"], current["labels"]) for i in ids if i in found]
    }
    if lane:
        # Only tasks just confirmed open get a Todofy ID (plan_store ADD_TASKS' rule).
        saved = await plan_store.save_lane_order(
            core.env.DB, plus_tasks.PROVIDER, lane, [i for i in ids if i in found], now_s()
        )
        answer["lane_order"] = {"lane": lane, "task_ids": saved}
    if commands or started:
        receipts.finish(core.sql, request_id, {})
    return answer
