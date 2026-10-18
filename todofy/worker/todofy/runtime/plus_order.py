"""ReorderTasks, run by plus_api.handle inside plus_lock (docs/todoist-plus.md, "Planning and completion").

A new order of up to MAX_LANE_TASKS tasks: one Review lane's, kept in the planning store (plan_store.save_lane_order),
or a parent's sub-tasks (no lane). In Todoist only the moved task's siblings among them change, and only in a lane
that does not sort by Todoist's update time (core/plus.py reorder_items, UNTOUCHED_LANES): one Sync under a receipt
(runtime/plus_receipts.py), and none when nothing changes.

Native Tasks permutes those same position slots with one bounded ReorderTasks RPC, committed atomically by Tasks.

``current`` is the caller's plan (plus_api.require_ready): the label mapping and the account's day.
"""

from typing import Any

from todofy.core import plan as planning
from todofy.core import plus
from todofy.runtime import native_plus, native_tasks, plan_store
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_todoist as todoist
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
    """ReorderTasks: reads before and after one source operation, plus an optional lane-order save.

    The receipt keeps the frozen item_reorder and finishes with no result: a repeat of a done one only reads the
    tasks again (and saves the same lane). A repeat of a started one reads the tasks and builds the items again:
    none left to change means its first try landed; the same items resend the frozen command, whose UUID Todoist
    runs once; anything else (a sibling moved or added in Todoist since) is ETAG_MISMATCH, so a retry never writes
    child_order values that are no longer the group's."""
    ids = request.get("task_ids", [])
    if not 1 <= len(ids) <= planning.MAX_LANE_TASKS or len(set(ids)) != len(ids):
        raise todoist.PlusError("BAD_REQUEST")
    ids = [plus.check_id(task_id) for task_id in ids]
    moved, lane = plus.check_id(request.get("task_id", "")), request.get("lane", "")
    if moved not in ids or lane not in ("", *planning.LANES):
        raise todoist.PlusError("BAD_REQUEST")
    request_id = request["request_id"]
    digest = plus.fingerprint(["ReorderTasks", request])
    previous = await receipts.find(core, request_id)
    if previous is not None and previous.request_hash != digest:
        raise todoist.PlusError("BAD_REQUEST")
    found = await todoist.active(core, ids)
    if native_tasks.enabled(core.env):
        commands = [] if lane in plus.UNTOUCHED_LANES else _native_updates(found, ids, moved, request_id)
    else:
        items = [] if lane in plus.UNTOUCHED_LANES else plus.reorder_items([found[i] for i in ids if i in found], moved)
        commands = [plus.reorder_command(request_id, items)] if items else []
    started = previous is not None and previous.result is None
    if previous is not None and not started:
        commands = []
    elif started and native_tasks.enabled(core.env):
        # Exact native requests keep their source etags and per-operation receipts after partial upstream failure.
        commands = previous.commands
    elif started and commands and commands != previous.commands:
        raise todoist.PlusError("ETAG_MISMATCH")
    if commands:
        await receipts.start(core, request_id, "ReorderTasks", digest, commands)
        if native_tasks.enabled(core.env) and started:
            await todoist._native(native_plus.resume(core, commands))
        else:
            await todoist.commands(core, commands)
        found = await todoist.active(core, ids)
    answer: dict[str, Any] = {
        "tasks": [plus.task_view(found[i], current["today"], current["labels"]) for i in ids if i in found]
    }
    if lane:
        # Only tasks just confirmed active get a Todofy ID (plan_store ADD_TASKS' rule).
        saved = await plan_store.save_lane_order(
            core.env.DB, todoist.provider(core), lane, [i for i in ids if i in found], now_s()
        )
        answer["lane_order"] = {"lane": lane, "task_ids": saved}
    if commands or started:
        receipts.finish(core.sql, request_id, {})
    return answer
