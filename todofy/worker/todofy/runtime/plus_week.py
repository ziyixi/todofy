"""Monday rollover of recorded commitments, within the existing coordinator schedule."""

import json
from typing import Any

from todofy.core import plus
from todofy.core.sql import native_plan as native_sql
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
    """One bounded page of ended weeks, in one D1 transaction. A recorded new-week choice never matches it.

    Rollover expires Todofy's own planning state; it never reads or changes Tasks.
    """
    env = core.env
    ended = await store.rows(env.DB, native_sql.ENDED_WEEK.sql, week)
    if not ended:
        return True
    existing = {}
    changes = []
    for record in ended:
        membership = {key: record[key] for key in ("task_id", "week_start", "committed", "bet")}
        request_id = "week:" + record["week_start"] + ":" + record["task_id"]
        # Native WeekReset receipts were always written to the object's SQLite. Read matching existing
        # receipts here; a fresh state-only transaction needs no cross-service journal.
        saved = core.sql.exec(
            "SELECT state FROM plus_receipts WHERE request_id=? AND method='WeekReset' AND request_hash=?"
            " AND created_at>=?",
            request_id,
            plus.fingerprint(membership),
            now_s() - receipts.MAX_AGE,
        ).toArray()
        if saved:
            existing[record["task_id"]] = (request_id, saved[0].state)
        changes.append(
            {
                **record,
                "request_id": plus.command_id(request_id),
                "cleanup": int(record["task_id"] not in existing),
                "reset": int(
                    record["committed"] and record["stage"] == "committed" and not (saved and saved[0].state == "done")
                ),
            }
        )
    document = json.dumps(changes, separators=(",", ":"))
    result = await env.DB.batch(
        [
            env.DB.prepare(native_sql.RESET_WEEK.sql).bind(now_s(), document),
            env.DB.prepare(native_sql.FORGET_WEEK.sql).bind(document),
        ]
    )
    updated = {dict(row)["task_id"] for row in result[0].results}
    finished = []
    for change in changes:
        if change["task_id"] in existing and (not change["reset"] or change["state_id"] in updated):
            # Keep existing receipts' memberships until their finish is durable. A failed sync may
            # leave a done receipt in memory, so the next pass also syncs it before deleting membership.
            request_id, state = existing[change["task_id"]]
            if state == "started":
                receipts.finish(core.sql, request_id, {})
            finished.append({**change, "cleanup": 1})
    if finished:
        await core.ctx.storage.sync()
        await env.DB.prepare(native_sql.FORGET_WEEK.sql).bind(json.dumps(finished, separators=(",", ":"))).all()
    return await store.first(env.DB, native_sql.WEEK_REMAINS.sql, week) is None


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
