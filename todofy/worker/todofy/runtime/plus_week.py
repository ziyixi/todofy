"""Monday rollover of recorded commitments, within the existing coordinator schedule."""

from typing import Any

from todofy.core import plus
from todofy.core.sql import plus as sql
from todofy.runtime import native_plan, plus_tasks
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_store as store
from todofy.runtime.interop import now_s


async def remember_page(env: Any, items: list[dict[str, Any]], week: str, mapping: list[dict[str, Any]]) -> None:
    settings = await store.settings(env.DB)
    if settings and settings["enabled"] and settings["week_start"] == week:
        await store.remember(env.DB, items, week, mapping)


async def reset_ended(core: Any, week: str) -> bool:
    """One bounded batch; a recorded new-week choice can never match this query."""
    env = core.env
    ended = await store.rows(env.DB, sql.ENDED_WEEK, week)
    for record in ended:
        task_id = record["task_id"]
        request_id = "week:" + record["week_start"] + ":" + task_id
        previous = await receipts.find(core, request_id)
        if previous and previous.result is not None:
            await store.run(env.DB, sql.FORGET_WEEK, task_id, record["week_start"])
            continue
        # Read first on a retry too: a task deleted since the stored update would otherwise fail it on every tick.
        try:
            task = await plus_tasks.task(core, task_id)
        except plus_tasks.PlusError as error:
            if error.reason != "NOT_FOUND":
                raise
            await store.run(env.DB, sql.FORGET_WEEK, task_id, record["week_start"])
            continue
        if previous:
            commands = previous.commands
        else:
            state = dict(task["_native_plan_state"])
            if not record["committed"] or state["stage"] != "committed":
                await store.run(env.DB, sql.FORGET_WEEK, task_id, record["week_start"])
                continue
            state["stage"] = "weekly"
            commands = [
                {
                    "method": "",
                    "body": {"name": f"tasks/{task_id}", "request_id": plus.command_id(request_id)},
                    "planning": {"state": state, "expected_rev": task["_native_plan_rev"]},
                }
            ]
        await receipts.start(core, request_id, "WeekReset", plus.fingerprint(record), commands)
        await plus_tasks.commands(core, commands)
        receipts.finish(core.sql, request_id, {})
        await store.run(env.DB, sql.FORGET_WEEK, task_id, record["week_start"])
    return len(ended) < sql.RESET_BATCH


async def tick(coordinator: Any) -> None:
    """At most once per cron interval, after the existing mail work. No configuration means no work."""
    if getattr(coordinator, "plus_next_tick", 0) > now_s():
        return
    coordinator.plus_next_tick = now_s() + 600
    async with coordinator.plus_lock:
        env = coordinator.env
        settings = await store.settings(env.DB)
        if not settings or not settings["enabled"] or not await native_plan.ready(env):
            return
        if coordinator.task_writes_wait(now_s()) is not None:
            return
        from todofy.runtime.plus_api import account_day

        week = plus.week_start(account_day(settings["timezone"]))
        if settings["week_start"] != week:
            if not await reset_ended(coordinator, week):
                return
            await store.run(env.DB, sql.ADVANCE_WEEK, week)
        # Observe one open page per tick. Track existing commitments, no task-content storage.
        cursor = getattr(coordinator, "plus_task_cursor", "")
        items, following = await plus_tasks.tasks(coordinator, cursor=cursor)
        await store.remember(env.DB, items, week, native_plan.CANONICAL_MAPPING)
        coordinator.plus_task_cursor = following
