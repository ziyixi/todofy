"""Typed Plus RPC handlers inside the existing single-writer Durable Object."""

import json
from datetime import date, timedelta
from typing import Any

import js
from pyodide.ffi import JsException
from ziyixi_proto.todofy.ui.v1 import plus_service_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from todofy.core import native_task_view, plus
from todofy.core import plan as planning
from todofy.core.sql import gtd as gtd_sql
from todofy.core.sql import mailbox as mailbox_sql
from todofy.core.sql import plus as sql
from todofy.runtime import (
    backup,
    native_plan,
    native_plan_actions,
    native_tasks,
    plan_store,
    plus_mail,
    plus_order,
    plus_tasks,
    plus_week,
)
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_store as store
from todofy.runtime.config import flag, var
from todofy.runtime.interop import now_s, to_js

READ_METHODS = frozenset(
    {"ReadPlan", "ListPlanningTasks", "VerifyPlanStore", "ListMailItems", "ReadMailSummary", "ReadMailSettings"}
)
# Writes of Todofy's planning store only, by value: no receipt, no task write (set_dependency, resolve).
DEPENDENCY_METHODS = frozenset({"SetTaskDependency", "ResolveDependencies"})
# Writes of D1 alone, by compare-and-set: resending one is safe by its value, so it carries no request ID.
VALUE_WRITES = frozenset({"SetWeeklyBet", "UpdateMailCategories"})
# What Tasks calls on its Planning channel (the gateway's allowlist, todofy/gateway/src/plus.ts NATIVE_METHODS).
METHODS = (
    READ_METHODS
    | DEPENDENCY_METHODS
    | VALUE_WRITES
    | {"SetTaskPlan", "SetTaskLead", "AppendTaskSteps", "CompleteTask", "ReorderTasks"}
    | {"ConvertMailItem", "DeleteMailSummaries"}
)
# Planning writes whose started receipt keeps the plan etag they were chosen under (plus_receipts.py).
PLAN_WRITES = frozenset({"SetTaskPlan", "SetTaskLead"})
# ResolveDependencies: the task IDs one call may name, and the gone prerequisites whose closing it reads.
RESOLVE_IDS = 20
RESOLVE_CLOSING_READS = 10


def account_day(timezone: str) -> str:
    return str(
        js.Intl.DateTimeFormat.new(
            "en-CA", to_js({"timeZone": timezone, "year": "numeric", "month": "2-digit", "day": "2-digit"})
        ).format(js.Date.new(now_s() * 1000))
    )


async def plan(core: Any, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """The plan of the account's day: ``metadata`` from the caller's catalog read, else one read here."""
    metadata = metadata if metadata is not None else await plus_tasks.metadata(core)
    today = account_day(metadata["timezone"])
    return {
        "native_planning": True,
        "enabled": await native_plan.ready(core.env),
        "timezone": metadata["timezone"],
        "today": today,
        "week_start": plus.week_start(today),
        "labels": native_plan.CANONICAL_MAPPING,
        "available_labels": [{"id": item["id"], "label": item["name"]} for item in metadata["labels"]],
        "missing_labels": [],
        "hidden_filter_ids": [],
        "etag": plus.fingerprint(["native-planning", metadata["timezone"]]),
    }


async def review_targets(env: Any, week: str) -> dict[str, Any]:
    """The weekly review's IDs, the Bets and the Review lanes' order, read with each Plan answer rather than with
    every task page or write: Todofy's mail project, the newest review task it created (this or the previous ISO
    week; the extension sees whether it is still open), the choices already kept for next week, every dependency,
    the Bets of last, this and next week, every lane the owner arranged, and the Mail entries still pending."""
    monday = date.fromisoformat(week)
    statements = [
        env.DB.prepare(gtd_sql.REVIEW_WEEK.sql).bind("{:04d}-W{:02d}".format(*day.isocalendar()[:2]))
        for day in (monday, monday - timedelta(days=7))
    ]
    *reviews, chosen, edges, bets, lanes, pending = await env.DB.batch(
        [
            *statements,
            env.DB.prepare(sql.NEXT_WEEK).bind(week),
            plan_store.edges(env.DB),
            plan_store.bets_statement(env.DB, week),
            plan_store.lane_orders_statement(env.DB),
            env.DB.prepare(mailbox_sql.NATIVE_COUNT.sql),
        ]
    )
    created = [
        str(row["task_id"])
        for result in reviews
        for row in (dict(item) for item in result.results)
        if row["state"] == "created" and row["task_id"]
    ]
    return {
        "inbox_project_id": var(env, "TODOIST_DEFAULT_PROJECT_ID"),
        "review_task_id": created[0] if created else "",
        "next_week_task_ids": [str(dict(row)["task_id"]) for row in chosen.results],
        "dependencies": plan_store.dependency_rows(edges),
        "weekly_bets": plan_store.weekly_bets(dict(row) for row in bets.results),
        "lane_orders": plan_store.lane_orders(lanes),
        "mailbox_pending_count": int(dict(pending.results[0])["n"]),
    }


async def require_ready(core: Any, current: dict[str, Any] | None = None) -> dict[str, Any]:
    """``current`` (else the plan read here) once it is enabled and its week is settled."""
    env = core.env
    current = current if current is not None else await plan(core)
    if not current["enabled"]:
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    settings = await store.settings(env.DB)
    if settings["week_start"] != current["week_start"]:
        # New-week decisions wait for one bounded reset batch; they never inherit the old membership.
        if not await plus_week.reset_ended(core, current["week_start"]):
            raise plus_tasks.PlusError("UNAVAILABLE")
        await store.run(env.DB, sql.ADVANCE_WEEK, current["week_start"])
    return current


async def set_weekly_bet(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """SetWeeklyBet: one plan_notes row by compare-and-set, never a Tasks call or a receipt. The account week is
    the confirmed timezone's; it needs no finished Monday reset, since a Bet changes no label. Sending the text already
    saved answers the saved Bet, whatever the etag and the day: a replay after a lost answer, even across Sunday
    midnight. Otherwise only this week and the next one take a write (ACTION_NOT_ALLOWED), from the etag shown
    (ETAG_MISMATCH)."""
    env = core.env
    week, area = request.get("week_start", ""), request.get("area", "")
    if area not in planning.BET_AREAS or date.fromisoformat(week).isoformat() != week:
        raise plus_tasks.PlusError("BAD_REQUEST")
    text = planning.bet_text(request.get("text", ""))
    setup, saved = await env.DB.batch([env.DB.prepare(sql.SETTINGS), plan_store.bet_statement(env.DB, week, area)])
    settings = next((dict(row) for row in setup.results), None)
    if settings is None or not settings["enabled"]:
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    unsaved = {"week_start": week, "area": area, "text": "", "etag": ""}
    current = next((plan_store.weekly_bet(dict(row)) for row in saved.results), unsaved)
    if current["text"] == text:
        return {"weekly_bet": current}
    if not planning.bet_writable(week, plus.week_start(account_day(settings["timezone"]))):
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    if request.get("etag", "") != current["etag"]:
        raise plus_tasks.PlusError("ETAG_MISMATCH")
    written = await plan_store.save_bet(env.DB, week, area, text, int(current["etag"] or 0), now_s())
    if written is None:
        raise plus_tasks.PlusError("ETAG_MISMATCH")
    return {"weekly_bet": written}


async def _dependencies_enabled(env: Any) -> None:
    """Dependency writes need only planning enabled: they change no task, so they do not wait for the week's
    reset."""
    settings = await store.settings(env.DB)
    if not settings or not settings["enabled"]:
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")


def _holds(edge: dict[str, Any], tasks: dict[str, dict[str, Any]], read: set[str]) -> bool:
    """Whether a dependency still holds back its task, by one read of the active tasks (``tasks``, of the IDs
    ``read``): both tasks are active and the prerequisite was not completed since (plus.holds). A dependency the
    read did not cover counts as holding."""
    waiter, prerequisite = edge["task_id"], edge["prerequisite_id"]
    if waiter not in read or prerequisite not in read:
        return True
    baseline = edge["baseline_completed_count"]
    return waiter in tasks and prerequisite in tasks and plus.holds(baseline, tasks[prerequisite])


async def set_dependency(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """SetTaskDependency, under plus_lock. Removing reads nothing. Adding reads Tasks once: both tasks, to confirm
    they are active and to take the prerequisite's completed_count as the baseline, with what the task waits for
    and every task the prerequisite waits for (through which a cycle would pass), to tell which dependencies still
    hold (core/plan.py check_dependency). Either is a value write: adding a dependency that holds answers it
    without a write, adding one that is done starts it over, and removing one that is gone changes nothing."""
    env = core.env
    await _dependencies_enabled(env)
    task_id, prerequisite_id = plus.check_id(request["task_id"]), plus.check_id(request["prerequisite_id"])
    if not request.get("waits"):
        return {
            "dependencies": await plan_store.remove_dependency(env.DB, plus_tasks.PROVIDER, task_id, prerequisite_id)
        }
    current = await plan_store.dependencies(env.DB)
    edges = [(edge["task_id"], edge["prerequisite_id"]) for edge in current]
    wanted = [task_id, prerequisite_id, *(waited for waiter, waited in edges if waiter == task_id)]
    read = list(dict.fromkeys([*wanted, *planning.prerequisites(edges, prerequisite_id)]))[: plus_tasks.ACTIVE_READ]
    tasks = await plus_tasks.active(core, read)
    if task_id not in tasks or prerequisite_id not in tasks:
        raise plus_tasks.PlusError("NOT_FOUND")
    prerequisite = tasks[prerequisite_id]
    baseline = plus.completed_count(prerequisite)
    if baseline is None and plus.recurring(prerequisite):
        # Only the counter tells a recurring task's next completion apart: it never leaves the active list.
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    covered = set(read)
    holding = [(edge["task_id"], edge["prerequisite_id"]) for edge in current if _holds(edge, tasks, covered)]
    if (task_id, prerequisite_id) in holding:
        return {"dependencies": [edge for edge in current if edge["task_id"] == task_id]}
    # Plan greys out a cycle and stops at the limits; this is the check that holds across tabs.
    refusal, replaced = planning.check_dependency(edges, holding, task_id, prerequisite_id)
    if refusal:
        raise plus_tasks.PlusError("ACTION_NOT_ALLOWED")
    dependencies = await plan_store.add_dependency(
        env.DB, plus_tasks.PROVIDER, task_id, prerequisite_id, baseline or 0, now_s(), replaced
    )
    return {"dependencies": dependencies}


async def resolve_dependencies(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ResolveDependencies, under plus_lock: settles the named tasks once Tasks confirms in one read which are open
    (a stale or partial read of Plan changes nothing). What a gone task waited for is removed. A gone prerequisite
    whose closing is not recorded costs one read of the task, at most RESOLVE_CLOSING_READS per call: completed keeps
    the dependencies on it, done; deleted (Tasks no longer has it) removes them, and their waiters are told; open
    again, they are removed too and their waiters told only that. A failed read leaves that task and the rest for the
    next check. A task recorded closed that Tasks lists again was reopened: it is open again, so a later deletion is
    settled."""
    env = core.env
    await _dependencies_enabled(env)
    task_ids = list(dict.fromkeys(plus.check_id(task_id) for task_id in request.get("task_ids", [])))
    if not 1 <= len(task_ids) <= RESOLVE_IDS:
        raise plus_tasks.PlusError("BAD_REQUEST")
    linked = await plan_store.dependency_roles(env.DB, plus_tasks.PROVIDER, task_ids)
    listed = await plus_tasks.active(core, [row["id"] for row in linked]) if linked else {}
    gone = [row for row in linked if row["id"] not in listed]
    deleted = [row["id"] for row in gone if row["awaited"] and row["closed_as"] == planning.DELETED]
    completed: list[str] = []
    released: list[str] = []
    unknown = [row["id"] for row in gone if row["awaited"] and row["closed_as"] is None][:RESOLVE_CLOSING_READS]
    for task_id in unknown:
        try:
            closed = await plus_tasks.closed_as(core, task_id)
        except plus_tasks.PlusError:
            break
        if closed == planning.COMPLETED:
            completed.append(task_id)
        elif closed == planning.DELETED:
            deleted.append(task_id)
        else:
            released.append(task_id)
    dependencies, dropped, left = await plan_store.settle(
        env.DB,
        plus_tasks.PROVIDER,
        now_s(),
        gone=[row["id"] for row in gone if row["waits"]],
        completed=completed,
        deleted=deleted,
        released=released,
        reopened=[row["id"] for row in linked if row["id"] in listed and row["closed_as"]],
    )
    # A task that is gone itself needs no notice, and one notice per task is enough.
    gone_ids = {row["id"] for row in gone}
    return {
        "dependencies": dependencies,
        "dropped_task_ids": [task_id for task_id in dropped if task_id not in gone_ids],
        "released_task_ids": [task_id for task_id in left if task_id not in gone_ids and task_id not in dropped],
    }


async def replayed(core: Any, method: str, result: dict[str, Any]) -> dict[str, Any]:
    """The answer of a done receipt, from the IDs it keeps: a planning write reads its task again."""
    if method in ("SetTaskPlan", "SetTaskLead"):
        current = await plan(core)
        task = await plus_tasks.task(core, result["task_id"])
        return {"task": plus.task_view(task, current["today"], current["labels"])}
    return {key: value for key, value in result.items() if key != "focus"}


async def mutate(core: Any, method: str, request: dict[str, Any]) -> dict[str, Any]:
    """One write that changes Tasks, under its receipt (runtime/plus_receipts.py)."""
    env = core.env
    request_id = request["request_id"]
    digest = plus.fingerprint([method, request])
    previous = await receipts.find(core, request_id)
    if previous:
        if previous.request_hash != digest:
            raise plus_tasks.PlusError("BAD_REQUEST")
        if previous.result is not None:
            return await replayed(core, method, previous.result)
    # One Tasks catalog serves the plan, the action and the confirming read of this write.
    catalog = await plus_tasks.native(native_tasks.catalog(env))
    current = await require_ready(core, await plan(core, native_task_view.metadata(catalog)))
    if previous and previous.plan_etag is not None and previous.plan_etag != current["etag"]:
        # Its frozen planning state was chosen under another plan (another account timezone): Plan reads the task
        # again.
        raise plus_tasks.PlusError("ETAG_MISMATCH")
    commands = previous.commands if previous else await native_plan_actions.build(core, method, request, catalog)
    await receipts.start(core, request_id, method, digest, commands, current["etag"] if method in PLAN_WRITES else None)
    result = await plus_tasks.commands(core, commands)
    if method in PLAN_WRITES:
        # Every explicit new-week write replaces the membership; old resets cannot select it. A commitment
        # chosen on the week's last day is recorded for the next week, so Monday's reset keeps it.
        # Recorded from the state just written, before the confirming read: if that read fails, the next
        # page scan would remember a Sunday choice under the ending week.
        if commands[0]["planning"]["state"]["stage"] == "committed":
            week = plus.membership_week(current["today"], current["week_start"], request)
            await store.run(env.DB, sql.REMEMBER_WEEK, request["task_id"], week, 1, 0)
        else:
            await store.run(env.DB, sql.FORGET_TASK, request["task_id"])
    if method == "CompleteTask":
        # Completed, not deleted, for every dependency on the task. A recurring task stays open, and the views
        # trust the open list first; what a completed task waited for goes once a complete read no longer
        # lists it (ResolveDependencies), so a recurring one keeps its dependencies. Tasks has closed the task
        # already, so the record is best effort: without it, ResolveDependencies reads the task.
        try:
            await plan_store.close_tasks(env.DB, plus_tasks.PROVIDER, [request["task_id"]], planning.COMPLETED, now_s())
        except Exception as error:
            print(json.dumps({"plus": "completion_unrecorded", "error_type": type(error).__name__}))
        response = kept = {"task_id": request["task_id"]}
    elif method == "AppendTaskSteps":
        response = kept = {"task_ids": result["task_ids"]}
        if not all(response["task_ids"]):
            raise plus_tasks.PlusError("UNAVAILABLE")
    else:
        task = await plus_tasks.native(native_tasks.task(env, request["task_id"], catalog))
        response = {"task": plus.task_view(task, current["today"], current["labels"])}
        kept = {"task_id": request["task_id"]}  # the task's title stays out of the receipt
    receipts.finish(core.sql, request_id, kept)
    return response


async def handle(coordinator: Any, method: str, text: str) -> dict[str, Any]:
    """One PlusService rpc from Tasks' Planning channel, for the owner Tasks authenticated."""
    try:
        if method not in METHODS:
            raise plus_tasks.PlusError("UNAUTHORIZED")
        request_type = getattr(pb, method + "Request")
        response_type = getattr(pb, method + "Response")
        message = from_wire(request_type, json.loads(text), strict=True).message
        request = to_wire(message)
        if method not in READ_METHODS:
            if flag(coordinator.env, "MAINTENANCE_MODE"):
                raise plus_tasks.PlusError("MAINTENANCE")
            if method not in VALUE_WRITES:
                plus.action_id(request.get("request_id", ""))
        async with coordinator.plus_lock:
            env = coordinator.env
            if method not in READ_METHODS and backup.holds_ledger(env, coordinator.sql, now_s()):
                raise plus_tasks.PlusError("MAINTENANCE")
            if method == "VerifyPlanStore":
                response = await plan_store.verify(env.DB)
            elif method == "ReadPlan":
                response = {"plan": await plan(coordinator)}
            elif method == "SetTaskDependency":
                response = await set_dependency(coordinator, request)
            elif method == "ResolveDependencies":
                response = await resolve_dependencies(coordinator, request)
            elif method == "SetWeeklyBet":
                response = await set_weekly_bet(coordinator, request)
            elif method == "ListMailItems":
                response = await plus_mail.list_items(coordinator, request)
            elif method == "ReadMailSummary":
                response = await plus_mail.read_summary(coordinator, request)
            elif method == "ReadMailSettings":
                response = await plus_mail.read_settings(coordinator)
            elif method == "UpdateMailCategories":
                response = await plus_mail.update_categories(coordinator, request, await plan(coordinator))
            elif method == "ConvertMailItem":
                response = await plus_mail.convert(coordinator, request, await plan(coordinator))
            elif method == "DeleteMailSummaries":
                response = await plus_mail.delete_summaries(coordinator, request)
            elif method == "ReorderTasks":
                response = await plus_order.reorder(coordinator, request, await require_ready(coordinator))
            elif method == "ListPlanningTasks":
                catalog = await plus_tasks.native(native_tasks.catalog(env))
                current = await plan(coordinator, native_task_view.metadata(catalog))
                size = request.get("page_size", 0) or 100
                cursor = request.get("page_token", "")
                ids = request.get("task_ids", [])
                if not 1 <= size <= 200 or len(cursor) > 2048 or len(ids) > 100 or len(set(ids)) != len(ids):
                    raise plus_tasks.PlusError("BAD_REQUEST")
                for task_id in ids:
                    plus.check_id(task_id)
                tasks, following = await plus_tasks.native(
                    native_tasks.page(env, cursor=cursor, limit=size, ids=ids, metadata=catalog)
                )
                if following and len(tasks) < size:
                    # Tasks pages hold at most 100: a larger request reads one more page with the same catalog.
                    more, following = await plus_tasks.native(
                        native_tasks.page(env, cursor=following, limit=size - len(tasks), ids=ids, metadata=catalog)
                    )
                    tasks = [*tasks, *more]
                if current["enabled"] and not backup.holds_ledger(env, coordinator.sql, now_s()):
                    await plus_week.remember_page(env, tasks, current["week_start"], current["labels"])
                response = {
                    "planning_tasks": [plus.task_view(task, current["today"], current["labels"]) for task in tasks],
                    "next_page_token": following,
                }
            else:
                response = await mutate(coordinator, method, request)
            # The BASIC view is the mapping without the weekly review's batch.
            if method == "ReadPlan" and message.view != pb.PlanView.BASIC:
                response = {"plan": {**response["plan"], **await review_targets(env, response["plan"]["week_start"])}}
            if method == "ReadPlan":
                # Pure rules use a local role projection; Plan sees ordinary labels only.
                response = {"plan": {**response["plan"], "labels": []}}
            message = from_wire(response_type, response, strict=True).message
            return {"ok": json.dumps(to_wire(message), separators=(",", ":")), "next_cursor": None}
    except plus_tasks.PlusError as error:
        reason = error.reason
    except (WireJsonError, ValueError, KeyError):
        reason = "BAD_REQUEST"
    except JsException:
        reason = "UNAVAILABLE"
    except Exception as error:
        print(json.dumps({"plus": "failed", "error_type": type(error).__name__}))
        reason = "INTERNAL"
    return {"error": reason, "detail": None, "retry_after": 30 if reason == "UNAVAILABLE" else None}
