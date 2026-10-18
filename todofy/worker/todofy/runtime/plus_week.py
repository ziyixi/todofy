"""Monday rollover of recorded commitments, within the existing coordinator schedule."""

import json
from typing import Any

from todofy.core import plus
from todofy.core.sql import plus as sql
from todofy.runtime import native_plan, native_plus, native_tasks
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_store as store
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.interop import now_s


async def remember_page(env: Any, items: list[dict[str, Any]], week: str, mapping: list[dict[str, Any]]) -> None:
    settings = await store.settings(env.DB)
    if settings and settings["enabled"] and settings["week_start"] == week:
        await store.remember(env.DB, items, week, mapping)


async def reset_ended(core: Any, week: str, mapping: list[dict[str, Any]]) -> bool:
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
            task = await todoist.task(core, task_id)
        except todoist.PlusError as error:
            if error.reason != "NOT_FOUND":
                raise
            await store.run(env.DB, sql.FORGET_WEEK, task_id, record["week_start"])
            continue
        if previous:
            commands = previous.commands
        elif native_tasks.enabled(env):
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
        else:
            labels = plus.reset_labels(task, record, mapping)
            if set(labels) == set(task.get("labels") or []):
                # No mark left to reset: skip the Todoist write, which could still change its updated_at.
                await store.run(env.DB, sql.FORGET_WEEK, task_id, record["week_start"])
                continue
            commands = [
                {
                    "type": "item_update",
                    "uuid": plus.command_id(request_id),
                    "args": {"id": task_id, "labels": labels},
                }
            ]
        await receipts.start(core, request_id, "WeekReset", plus.fingerprint(record), commands)
        if native_tasks.enabled(env) and previous is not None:
            await todoist._native(native_plus.resume(core, commands))
        else:
            await todoist.commands(core, commands)
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
        if not settings or not settings["enabled"]:
            return
        if native_tasks.enabled(env) and not await native_plan.ready(env):
            return
        if coordinator.todoist_wait(now_s()) is not None:
            return
        from todofy.runtime.plus_api import account_day

        week = plus.week_start(account_day(settings["timezone"]))
        if settings["week_start"] != week:
            # Recheck identity before modifying any Todoist labels.
            metadata = await todoist.metadata(coordinator, fresh=True)
            actual = (
                {"labels": native_plan.CANONICAL_MAPPING}
                if native_tasks.enabled(env)
                else plus.discover(metadata["labels"], metadata["timezone"], json.loads(settings["mapping"])["labels"])
            )
            if not native_tasks.enabled(env) and actual["etag"] != json.loads(settings["mapping"])["etag"]:
                raise todoist.PlusError("ACTION_NOT_ALLOWED")
            if not await reset_ended(coordinator, week, actual["labels"]):
                return
            await store.run(env.DB, sql.ADVANCE_WEEK, week)
        # Observe one active page per tick. Track existing commitments, no task-content storage.
        cursor = getattr(coordinator, "plus_task_cursor", "")
        items, following = await todoist.tasks(coordinator, cursor=cursor)
        mapping = (
            native_plan.CANONICAL_MAPPING if native_tasks.enabled(env) else json.loads(settings["mapping"])["labels"]
        )
        await store.remember(env.DB, items, week, mapping)
        coordinator.plus_task_cursor = following
