"""Typed Plus RPC handlers inside the existing single-writer Durable Object."""

import hashlib
import json
import secrets
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
    native_plus,
    native_tasks,
    plan_store,
    plus_cache,
    plus_mail,
    plus_order,
    plus_week,
)
from todofy.runtime import plus_receipts as receipts
from todofy.runtime import plus_store as store
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.config import flag, var
from todofy.runtime.interop import now_s, to_js

OWNER_METHODS = frozenset(
    {
        "ConfirmPlanMapping",
        "IssueExtensionConnection",
        "ReadExtensionConnections",
        "RevokeExtensionConnection",
        "VerifyPlanStore",
    }
)
READ_METHODS = frozenset(
    {
        "ReadPlan",
        "ListPlanningTasks",
        "ReadExtensionConnections",
        "VerifyPlanStore",
        "LookupMailItems",
        "ListMailItems",
        "ReadMailSummary",
        "ReadMailSettings",
    }
)
PLAN_METHODS = frozenset({"ReadPlan", "ConfirmPlanMapping", "UpdatePlanLabels"})
# Writes of Todofy's planning store only, by value: no receipt, no Todoist write (set_dependency, resolve).
DEPENDENCY_METHODS = frozenset({"SetTaskDependency", "ResolveDependencies"})
# Writes of D1 alone, by compare-and-set: resending one is safe by its value, so it carries no request ID.
VALUE_WRITES = frozenset({"SetWeeklyBet", "UpdateMailSettings", "UpdateMailCategories"})
METHODS = (
    READ_METHODS
    | OWNER_METHODS
    | DEPENDENCY_METHODS
    | VALUE_WRITES
    | {"SetTaskPlan", "SetTaskLead", "AppendTaskSteps", "CompleteTask", "UpdatePlanLabels", "ReorderTasks"}
    | {"FileMailItem", "DeleteMailItems", "ConvertMailItem", "DeleteMailSummaries"}
)
# Methods that write labels or bind them sync Todoist's labels first, so a label renamed in Todoist is never
# written back under its old name; every other call reads the metadata the object synced in the last five
# minutes (plus_todoist.metadata). FileMailItem syncs only when it files by a category (handle).
LABEL_WRITES = frozenset(
    {
        "SetTaskPlan",
        "SetTaskLead",
        "UpdatePlanLabels",
        "ConfirmPlanMapping",
        "FileMailItem",
        "UpdateMailSettings",
        "ConvertMailItem",
        "UpdateMailCategories",
    }
)
# SetTaskPlan's fields that add one of the owner's literal labels when true (core/plus.plan_labels).
LITERAL_LABELS = {"active": plus.ACTIVE, "parked": plus.PARKED}
# How long the object trusts its copy of the non-revoked connection digests; Issue and Revoke drop it at once
# (_change_connections).
CONNECTIONS_MAX_AGE = 10 * 60
# ResolveDependencies: the task IDs one call may name, and the prerequisites whose activity log it reads.
RESOLVE_IDS = 20
RESOLVE_ACTIVITY_READS = 10


def account_day(timezone: str) -> str:
    return str(
        js.Intl.DateTimeFormat.new(
            "en-CA", to_js({"timeZone": timezone, "year": "numeric", "month": "2-digit", "day": "2-digit"})
        ).format(js.Date.new(now_s() * 1000))
    )


async def plan(core: Any, metadata: dict[str, Any] | None = None, *, fresh: bool = False) -> dict[str, Any]:
    env = core.env
    metadata = metadata if metadata is not None else await todoist.metadata(core, fresh=fresh)
    if native_tasks.enabled(env):
        today = account_day(metadata["timezone"])
        return {
            "native_planning": True,
            "enabled": await native_plan.ready(env),
            "timezone": metadata["timezone"],
            "today": today,
            "week_start": plus.week_start(today),
            "labels": native_plan.CANONICAL_MAPPING,
            "available_labels": [{"id": item["id"], "label": item["name"]} for item in metadata["labels"]],
            "missing_labels": [],
            "hidden_filter_ids": [],
            "etag": plus.fingerprint(["native-planning", metadata["timezone"]]),
        }
    current = await store.settings(env.DB)
    saved = json.loads(current["mapping"]) if current else None
    discovered = plus.discover(metadata["labels"], metadata["timezone"], saved["labels"] if saved else None)
    enabled = bool(current and current["enabled"] and saved["etag"] == discovered["etag"])
    today = account_day(metadata["timezone"])
    return {
        **discovered,
        "timezone": metadata["timezone"],
        "today": today,
        "week_start": plus.week_start(today),
        "enabled": enabled,
        "hidden_filter_ids": plus.replaced_filters(metadata["filters"], discovered["labels"], _names(metadata)),
    }


def _names(metadata: dict[str, Any]) -> set[str]:
    """The names of the account's labels."""
    return {label["name"] for label in metadata["labels"]}


async def review_targets(env: Any, week: str) -> dict[str, Any]:
    """The weekly review's IDs, the Bets and the Review lanes' order, read with each Plan answer rather than with
    every task page or write: Todofy's mail project, the newest review task it created (this or the previous ISO
    week; the extension sees whether it is still open), the choices already kept for next week, every dependency,
    the Bets of last, this and next week, and every lane the owner arranged."""
    monday = date.fromisoformat(week)
    statements = [
        env.DB.prepare(gtd_sql.REVIEW_WEEK.sql).bind("{:04d}-W{:02d}".format(*day.isocalendar()[:2]))
        for day in (monday, monday - timedelta(days=7))
    ]
    native = native_tasks.enabled(env)
    results = list(
        await env.DB.batch(
            [
                *statements,
                env.DB.prepare(sql.NEXT_WEEK).bind(week),
                plan_store.edges(env.DB),
                plan_store.bets_statement(env.DB, week),
                plan_store.lane_orders_statement(env.DB),
                *([env.DB.prepare(mailbox_sql.NATIVE_COUNT.sql)] if native else []),
            ]
        )
    )
    pending = int(dict(results.pop().results[0])["n"]) if native else None
    *reviews, chosen, edges, bets, lanes = results
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
        **({"mailbox_pending_count": pending} if native else {}),
    }


async def require_ready(core: Any, current: dict[str, Any] | None = None, *, synced: bool = False) -> dict[str, Any]:
    """``current`` (else the plan from the cached metadata) once it is enabled and its week is settled.
    ``synced``: ``current`` comes from labels synced in this call."""
    env = core.env
    current = current if current is not None else await plan(core)
    if not current["enabled"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    settings = await store.settings(env.DB)
    if settings["week_start"] != current["week_start"]:
        # New-week decisions wait for one bounded reset batch; they never inherit the old membership. The reset
        # writes labels, so it starts from labels synced in this call (under PLUS_METADATA=full every plan is).
        if not synced and plus_cache.enabled(env):
            current = await plan(core, fresh=True)
            if not current["enabled"]:
                raise todoist.PlusError("ACTION_NOT_ALLOWED")
        if not await plus_week.reset_ended(core, current["week_start"], current["labels"]):
            raise todoist.PlusError("UNAVAILABLE")
        await store.run(env.DB, sql.ADVANCE_WEEK, current["week_start"])
    return current


async def confirm(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    env = core.env
    if native_tasks.enabled(env):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    current = await plan(core, fresh=True)
    if current["etag"] != request["etag"]:
        raise todoist.PlusError("ETAG_MISMATCH")
    if current["missing_labels"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if current["enabled"]:
        # A repeated setup must still settle an ended week, never adopt its marks as fresh decisions.
        return {"plan": await require_ready(core, current, synced=True)}
    # Complete the initial membership read before enabling Monday writes.
    tasks: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(10):
        page, cursor = await todoist.tasks(core, cursor=cursor)
        tasks.extend(page)
        if not cursor:
            break
    if cursor:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    await store.remember(env.DB, tasks, current["week_start"], current["labels"])
    await store.run(
        env.DB,
        sql.SAVE_SETTINGS,
        json.dumps({"etag": current["etag"], "labels": current["labels"]}),
        current["timezone"],
        current["week_start"],
    )
    current["enabled"] = True
    return {"plan": current}


def _saved(current: dict[str, Any], request: dict[str, Any]) -> bool:
    """Whether UpdatePlanLabels' ``request`` binds the labels ``current`` already has (a replay)."""
    try:
        bindings = plus.replace_planning_labels(current["labels"], request["labels"], current["available_labels"])
    except ValueError:
        return False
    return bindings == current["labels"]


async def update_labels(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """Only the binding in D1 changes, no Todoist task, so there is no receipt: a request whose etag is outdated
    is a replay when the binding it asks for is the saved one, and answers the saved plan."""
    env = core.env
    if native_tasks.enabled(env):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    metadata = await todoist.metadata(core, fresh=True)
    current = await plan(core, metadata)
    if request["etag"] != current["etag"]:
        if not _saved(current, request):
            raise todoist.PlusError("ETAG_MISMATCH")
        return {"plan": await require_ready(core, current, synced=True)}
    bindings = plus.replace_planning_labels(current["labels"], request["labels"], current["available_labels"])
    # Settle old-week work using its old binding identities before changing configuration.
    current = await require_ready(core, current, synced=True)
    updated = {
        **current,
        "labels": bindings,
        "etag": plus.fingerprint([bindings, current["timezone"]]),
        "hidden_filter_ids": plus.replaced_filters(metadata["filters"], bindings, _names(metadata)),
    }
    mapping = json.dumps({"etag": updated["etag"], "labels": bindings}, separators=(",", ":"))
    await store.run(env.DB, sql.SAVE_SETTINGS, mapping, current["timezone"], current["week_start"])
    return {"plan": updated}


async def set_weekly_bet(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """SetWeeklyBet: one plan_notes row by compare-and-set, never a Todoist call or a receipt. The account week is
    the confirmed timezone's; it needs no finished Monday reset, since a Bet changes no label. Sending the text already
    saved answers the saved Bet, whatever the etag and the day: a replay after a lost answer, even across Sunday
    midnight. Otherwise only this week and the next one take a write (ACTION_NOT_ALLOWED), from the etag shown
    (ETAG_MISMATCH)."""
    env = core.env
    week, area = request.get("week_start", ""), request.get("area", "")
    if area not in planning.BET_AREAS or date.fromisoformat(week).isoformat() != week:
        raise todoist.PlusError("BAD_REQUEST")
    text = planning.bet_text(request.get("text", ""))
    setup, saved = await env.DB.batch([env.DB.prepare(sql.SETTINGS), plan_store.bet_statement(env.DB, week, area)])
    settings = next((dict(row) for row in setup.results), None)
    if settings is None or not settings["enabled"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    unsaved = {"week_start": week, "area": area, "text": "", "etag": ""}
    current = next((plan_store.weekly_bet(dict(row)) for row in saved.results), unsaved)
    if current["text"] == text:
        return {"weekly_bet": current}
    if not planning.bet_writable(week, plus.week_start(account_day(settings["timezone"]))):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if request.get("etag", "") != current["etag"]:
        raise todoist.PlusError("ETAG_MISMATCH")
    written = await plan_store.save_bet(env.DB, week, area, text, int(current["etag"] or 0), now_s())
    if written is None:
        raise todoist.PlusError("ETAG_MISMATCH")
    return {"weekly_bet": written}


async def connected(core: Any, digest: str) -> bool:
    """Whether ``digest`` is a non-revoked extension connection's: the object's copy of D1, read again after
    CONNECTIONS_MAX_AGE. A failed D1 read raises (JsException) rather than trusting an older copy.

    The check runs outside plus_lock and D1 is not the object's storage, so Issue or Revoke can commit while its
    read is in flight: a read that one of them overlapped answers its own call but is not kept."""
    env = core.env
    if len(digest) != 64:
        return False
    if not plus_cache.enabled(env):
        return await store.first(env.DB, sql.CONNECTION, digest) is not None
    now = now_s()
    cached = plus_cache.get(core.sql, "connections")
    if cached is None or now - cached.refreshed_at > CONNECTIONS_MAX_AGE:
        changes = core.plus_connection_changes
        digests = [row["token_sha256"] for row in await store.rows(env.DB, sql.ACTIVE_DIGESTS)]
        if core.plus_connection_changes == changes:
            plus_cache.put(core.sql, "connections", digests, now)
        return digest in digests
    return digest in cached.value


def _drop_connections(core: Any) -> None:
    core.plus_connection_changes += 1
    plus_cache.drop(core.sql, "connections")


async def _change_connections(core: Any, statement: str, *args: Any) -> None:
    """Issue's or Revoke's D1 write, so that it holds from the next token check on: the object's copy is dropped
    before the write (none is left when its answer is lost) and after it, and the counter keeps a check whose
    read overlapped the write from storing a copy (connected)."""
    _drop_connections(core)
    try:
        await store.run(core.env.DB, statement, *args)
    finally:
        _drop_connections(core)


async def connections(core: Any, method: str, request: dict[str, Any]) -> dict[str, Any]:
    env = core.env
    if method == "IssueExtensionConnection" and native_tasks.enabled(env):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if method == "ReadExtensionConnections":
        rows = await store.rows(env.DB, sql.CONNECTIONS)
        return {"connections": [{**row, "revoked": bool(row["revoked"])} for row in rows]}
    if method == "RevokeExtensionConnection":
        await _change_connections(core, sql.REVOKE_CONNECTION, plus.check_id(request["connection_id"]))
        return {}
    display_name = request["display_name"].strip()
    if not 1 <= len(display_name) <= 60:
        raise todoist.PlusError("BAD_REQUEST")
    rows = await store.rows(env.DB, sql.CONNECTIONS)
    existing = next((row for row in rows if row["id"] == request["request_id"]), None)
    if existing:
        if existing["display_name"] != display_name:
            raise todoist.PlusError("BAD_REQUEST")
        return {"connection": {**existing, "revoked": bool(existing["revoked"])}}
    if len(rows) >= 30:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    token = "todofy_plus_" + secrets.token_urlsafe(32)
    await _change_connections(
        core,
        sql.CREATE_CONNECTION,
        request["request_id"],
        display_name,
        hashlib.sha256(token.encode()).hexdigest(),
        now_s(),
    )
    return {"connection": {"id": request["request_id"], "display_name": display_name, "revoked": False}, "token": token}


async def _dependencies_enabled(env: Any) -> None:
    """Dependency writes need only Plus enabled: they change no Todoist label, so they neither sync labels nor
    wait for the week's reset."""
    settings = await store.settings(env.DB)
    if not settings or not settings["enabled"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")


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
    """SetTaskDependency, under plus_lock. Removing reads nothing. Adding reads Todoist once: both tasks, to confirm
    they are active and to take the prerequisite's completed_count as the baseline, with what the task waits for
    and every task the prerequisite waits for (through which a cycle would pass), to tell which dependencies still
    hold (core/plan.py check_dependency). Either is a value write: adding a dependency that holds answers it
    without a write, adding one that is done starts it over, and removing one that is gone changes nothing."""
    env = core.env
    await _dependencies_enabled(env)
    task_id, prerequisite_id = plus.check_id(request["task_id"]), plus.check_id(request["prerequisite_id"])
    if not request.get("waits"):
        return {
            "dependencies": await plan_store.remove_dependency(env.DB, todoist.provider(core), task_id, prerequisite_id)
        }
    current = await plan_store.dependencies(env.DB)
    edges = [(edge["task_id"], edge["prerequisite_id"]) for edge in current]
    wanted = [task_id, prerequisite_id, *(waited for waiter, waited in edges if waiter == task_id)]
    read = list(dict.fromkeys([*wanted, *planning.prerequisites(edges, prerequisite_id)]))[: todoist.ACTIVE_READ]
    tasks = await todoist.active(core, read)
    if task_id not in tasks or prerequisite_id not in tasks:
        raise todoist.PlusError("NOT_FOUND")
    prerequisite = tasks[prerequisite_id]
    baseline = plus.completed_count(prerequisite)
    if baseline is None and plus.recurring(prerequisite):
        # Only the counter tells a recurring task's next completion apart: it never leaves the active list.
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    covered = set(read)
    holding = [(edge["task_id"], edge["prerequisite_id"]) for edge in current if _holds(edge, tasks, covered)]
    if (task_id, prerequisite_id) in holding:
        return {"dependencies": [edge for edge in current if edge["task_id"] == task_id]}
    # The extension greys out a cycle and stops at the limits; this is the check that holds across tabs.
    refusal, replaced = planning.check_dependency(edges, holding, task_id, prerequisite_id)
    if refusal:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    dependencies = await plan_store.add_dependency(
        env.DB, todoist.provider(core), task_id, prerequisite_id, baseline or 0, now_s(), replaced
    )
    return {"dependencies": dependencies}


async def resolve_dependencies(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ResolveDependencies, under plus_lock: settles the named tasks once Todoist confirms in one read which are
    active (a stale or partial read of the extension changes nothing). What a gone task waited for is removed. A
    gone prerequisite whose closing is not recorded costs one activity-log read, at most RESOLVE_ACTIVITY_READS per
    call: completed keeps the dependencies on it, done; deleted removes them, and their waiters are told; when the
    log does not say (no closing event, or a plan without the log, which answers 403), they are removed too and
    their waiters told only that. Any other failed read leaves that task and the rest for the next check. A task
    recorded closed that Todoist lists again was reopened: it is open again, so a later deletion is settled."""
    env = core.env
    await _dependencies_enabled(env)
    task_ids = list(dict.fromkeys(plus.check_id(task_id) for task_id in request.get("task_ids", [])))
    if not 1 <= len(task_ids) <= RESOLVE_IDS:
        raise todoist.PlusError("BAD_REQUEST")
    linked = await plan_store.dependency_roles(env.DB, todoist.provider(core), task_ids)
    listed = await todoist.active(core, [row["id"] for row in linked]) if linked else {}
    gone = [row for row in linked if row["id"] not in listed]
    deleted = [row["id"] for row in gone if row["awaited"] and row["closed_as"] == planning.DELETED]
    completed: list[str] = []
    released: list[str] = []
    unknown = [row["id"] for row in gone if row["awaited"] and row["closed_as"] is None][:RESOLVE_ACTIVITY_READS]
    for position, task_id in enumerate(unknown):
        try:
            closed = await todoist.closed_as(core, task_id)
        except todoist.PlusError as error:
            if error.status == 403:
                # The account's plan has no activity log: nothing tells a completion from a deletion.
                released += unknown[position:]
            break
        if closed == planning.COMPLETED:
            completed.append(task_id)
        elif closed == planning.DELETED:
            deleted.append(task_id)
        else:
            released.append(task_id)
    dependencies, dropped, left = await plan_store.settle(
        env.DB,
        todoist.provider(core),
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


async def build_commands(
    core: Any,
    method: str,
    request: dict[str, Any],
    mapping: list[dict[str, Any]],
    catalog: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if native_tasks.enabled(core.env):
        return await native_plan_actions.build(core, method, request, catalog)
    request_id = request["request_id"]
    task_id = plus.check_id(request.get("task_id") or request.get("parent_id", ""))
    if method == "CompleteTask":
        if request.get("task_etag") or request.get("flow_task_id"):
            raise todoist.PlusError("BAD_REQUEST")
        flow_date = request.get("flow_date", "")
        if flow_date and date.fromisoformat(flow_date).isoformat() != flow_date:
            raise todoist.PlusError("BAD_REQUEST")
        return [
            {
                "type": "item_close",
                "uuid": plus.command_id(request_id),
                "args": {"id": task_id},
            }
        ]
    task = await todoist.task(core, task_id)
    if method == "AppendTaskSteps":
        steps = request.get("steps", [])
        if not 1 <= len(steps) <= 20:
            raise todoist.PlusError("BAD_REQUEST")
        commands = []
        for index, step in enumerate(steps):
            title = step["title"].strip()
            estimate = step.get("estimated_minutes")
            if not 1 <= len(title) <= 500 or (estimate is not None and not 1 <= estimate <= 10080):
                raise todoist.PlusError("BAD_REQUEST")
            args = {
                "content": title,
                "project_id": task["project_id"],
                "parent_id": task_id,
                "auto_parse_labels": False,
            }
            if estimate is not None:
                args["duration"] = {"amount": estimate, "unit": "minute"}
            commands.append(
                {
                    "type": "item_add",
                    "uuid": plus.command_id(request_id, index),
                    "temp_id": plus.command_id(request_id, index + 100),
                    "args": args,
                }
            )
        return commands
    if request.get("etag") != plus.task_etag(task, mapping):
        raise todoist.PlusError("ETAG_MISMATCH")
    args = (
        {"labels": plus.plan_labels(task, request, mapping)}
        if method == "SetTaskPlan"
        else plus.lead_args(task, request.get("deadline", ""), request.get("lead_days", 0), mapping)
    )
    return [
        {
            "type": "item_update",
            "uuid": plus.command_id(request_id),
            "args": {"id": task_id, **args},
        }
    ]


async def replayed(core: Any, method: str, result: dict[str, Any]) -> dict[str, Any]:
    """The answer of a done receipt, from the IDs it keeps: a planning write reads its task again."""
    if method in ("SetTaskPlan", "SetTaskLead"):
        current = await plan(core)
        task = await todoist.task(core, result["task_id"])
        return {"task": plus.task_view(task, current["today"], current["labels"])}
    return {key: value for key, value in result.items() if key != "focus"}


async def mutate(core: Any, method: str, request: dict[str, Any]) -> dict[str, Any]:
    """One write that changes Todoist, under its receipt (runtime/plus_receipts.py)."""
    env = core.env
    request_id = request["request_id"]
    digest = plus.fingerprint([method, request])
    previous = await receipts.find(core, request_id)
    if previous:
        if previous.request_hash != digest:
            raise todoist.PlusError("BAD_REQUEST")
        if previous.result is not None:
            # A D1 receipt of the release before kept the whole answer.
            return previous.result if previous.legacy else await replayed(core, method, previous.result)
    synced = method in LABEL_WRITES
    # One Tasks catalog serves the plan, the action and the confirming read of this write.
    catalog = await todoist._native(native_tasks.catalog(env)) if native_tasks.enabled(env) else None
    metadata = native_task_view.metadata(catalog) if catalog is not None else None
    current = await require_ready(core, await plan(core, metadata, fresh=synced), synced=synced)
    if previous and previous.plan_etag is not None and previous.plan_etag != current["etag"]:
        # Its frozen labels were chosen under another binding: resending them could attach a label by a name
        # that no longer has its role. The extension reads the task again.
        raise todoist.PlusError("ETAG_MISMATCH")
    if previous:
        commands = previous.commands
    else:
        available = {label["label"] for label in current["available_labels"]}
        if not native_tasks.enabled(env) and any(
            request.get(field) and label not in available for field, label in LITERAL_LABELS.items()
        ):
            # Todoist would create a label for an unknown name; Plus never creates one.
            raise todoist.PlusError("ACTION_NOT_ALLOWED")
        commands = await build_commands(core, method, request, current["labels"], catalog)
    await receipts.start(core, request_id, method, digest, commands, current["etag"] if synced else None)
    result = (
        await todoist._native(native_plus.resume(core, commands))
        if native_tasks.enabled(env) and previous is not None
        else await todoist.commands(core, commands)
    )
    if method in ("SetTaskPlan", "SetTaskLead"):
        # Every explicit new-week write replaces the membership; old resets cannot select it. A commitment
        # chosen on the week's last day is recorded for the next week, so Monday's reset keeps it.
        # Recorded from the labels just written, before the confirming read: if that read fails, the next
        # page scan would remember a Sunday choice under the ending week.
        if native_tasks.enabled(env):
            state = (
                commands[0]["planning"]["state"]
                if "planning" in commands[0]
                else native_plan.state_from_labels(commands[0]["args"]["labels"])
            )
            marks = int(state["stage"] == "committed"), 0
        else:
            written = commands[0]["args"]["labels"]
            names = plus.role_labels(current["labels"])
            marks = int(names["committed"] in written), int(names.get("bets") in written)
        if any(marks):
            week = plus.membership_week(current["today"], current["week_start"], request)
            await store.run(env.DB, sql.REMEMBER_WEEK, request["task_id"], week, *marks)
        else:
            await store.run(env.DB, sql.FORGET_TASK, request["task_id"])
    if method == "CompleteTask":
        # Completed, not deleted, for every dependency on the task. A recurring task stays active, and the views
        # trust the active list first; what a completed task waited for goes once a complete read no longer
        # lists it (ResolveDependencies), so a recurring one keeps its dependencies. Todoist has closed the task
        # already, so the record is best effort: without it, ResolveDependencies reads the activity log.
        try:
            await plan_store.close_tasks(
                env.DB, todoist.provider(core), [request["task_id"]], planning.COMPLETED, now_s()
            )
        except Exception as error:
            print(json.dumps({"plus": "completion_unrecorded", "error_type": type(error).__name__}))
        response = kept = {"task_id": request["task_id"]}
    elif method == "AppendTaskSteps":
        ids = result.get("temp_id_mapping", {})
        created = result.get("task_ids")
        response = kept = {
            "task_ids": created
            if created is not None
            else [str(ids.get(command["temp_id"], "")) for command in commands]
        }
        if not all(response["task_ids"]):
            raise todoist.PlusError("UNAVAILABLE")
    else:
        task = await (
            todoist._native(native_tasks.task(env, request["task_id"], catalog))
            if catalog is not None
            else todoist.task(core, request["task_id"])
        )
        response = {"task": plus.task_view(task, current["today"], current["labels"])}
        kept = {"task_id": request["task_id"]}  # the task's title stays out of the receipt
    receipts.finish(core.sql, request_id, kept)
    return response


async def handle(coordinator: Any, method: str, text: str, *, owner: bool, digest: str | None = None) -> dict[str, Any]:
    """One PlusService rpc for the Access owner (``owner``) or for the extension connection whose token's SHA-256
    the gateway passes as ``digest``."""
    try:
        if not owner:
            if digest is None:
                # Fail closed: only the gateway before this release calls without it, while CI deploys this core
                # first; the next call, through the new gateway, is served.
                raise todoist.PlusError("UNAVAILABLE")
            if not await connected(coordinator, digest):
                raise todoist.PlusError("UNAUTHORIZED")
        if method not in METHODS or (method in OWNER_METHODS and not owner):
            raise todoist.PlusError("UNAUTHORIZED")
        request_type = getattr(pb, method + "Request")
        response_type = getattr(pb, method + "Response")
        message = from_wire(request_type, json.loads(text), strict=True).message
        request = to_wire(message)
        if method not in READ_METHODS:
            if flag(coordinator.env, "MAINTENANCE_MODE"):
                raise todoist.PlusError("MAINTENANCE")
            if method not in VALUE_WRITES:
                plus.action_id(request.get("request_id", ""))
        async with coordinator.plus_lock:
            env = coordinator.env
            if method not in READ_METHODS and backup.holds_ledger(env, coordinator.sql, now_s()):
                raise todoist.PlusError("MAINTENANCE")
            if method in {"IssueExtensionConnection", "ReadExtensionConnections", "RevokeExtensionConnection"}:
                response = await connections(coordinator, method, request)
            elif method == "VerifyPlanStore":
                response = await plan_store.verify(env.DB)
            elif method == "ReadPlan":
                response = {"plan": await plan(coordinator)}
            elif method == "ConfirmPlanMapping":
                response = await confirm(coordinator, request)
            elif method == "UpdatePlanLabels":
                response = await update_labels(coordinator, request)
            elif method == "SetTaskDependency":
                response = await set_dependency(coordinator, request)
            elif method == "ResolveDependencies":
                response = await resolve_dependencies(coordinator, request)
            elif method == "SetWeeklyBet":
                response = await set_weekly_bet(coordinator, request)
            elif method == "LookupMailItems":
                response = await plus_mail.lookup(coordinator, request)
            elif method == "ListMailItems":
                response = await plus_mail.list_items(coordinator, request)
            elif method == "ReadMailSummary":
                response = await plus_mail.read_summary(coordinator, request)
            elif method == "ReadMailSettings":
                response = await plus_mail.read_settings(coordinator)
            elif method == "UpdateMailSettings":
                current = await require_ready(coordinator, await plan(coordinator, fresh=True), synced=True)
                response = await plus_mail.update_settings(coordinator, request, current)
            elif method == "UpdateMailCategories":
                if not native_tasks.enabled(env):
                    raise todoist.PlusError("ACTION_NOT_ALLOWED")
                response = await plus_mail.update_settings(coordinator, request, await plan(coordinator, fresh=True))
            elif method == "ConvertMailItem":
                if not native_tasks.enabled(env):
                    raise todoist.PlusError("ACTION_NOT_ALLOWED")
                current = await plan(coordinator, fresh=bool(request.get("category_id")))
                response = await plus_mail.file(coordinator, request, current)
            elif method == "DeleteMailSummaries":
                response = await plus_mail.delete(coordinator, request)
            elif method == "FileMailItem":
                # Only a category writes a label: a move to the Inbox alone uses the cached metadata.
                fresh = bool(request.get("category_id"))
                current = await require_ready(coordinator, await plan(coordinator, fresh=fresh), synced=fresh)
                response = await plus_mail.file(coordinator, request, current)
            elif method == "DeleteMailItems":
                await require_ready(coordinator)
                response = await plus_mail.delete(coordinator, request)
            elif method == "ReorderTasks":
                # The order writes no label: the cached metadata.
                response = await plus_order.reorder(coordinator, request, await require_ready(coordinator))
            elif method == "ListPlanningTasks":
                catalog = await todoist._native(native_tasks.catalog(env)) if native_tasks.enabled(env) else None
                current = await plan(coordinator, native_task_view.metadata(catalog) if catalog is not None else None)
                size = request.get("page_size", 0) or 100
                cursor = request.get("page_token", "")
                ids = request.get("task_ids", [])
                if not 1 <= size <= 200 or len(cursor) > 2048 or len(ids) > 100 or len(set(ids)) != len(ids):
                    raise todoist.PlusError("BAD_REQUEST")
                for task_id in ids:
                    plus.check_id(task_id)
                if catalog is not None:
                    tasks, following = await todoist._native(
                        native_tasks.page(env, cursor=cursor, limit=size, ids=ids, metadata=catalog)
                    )
                    if following and len(tasks) < size:
                        # Tasks pages hold at most 100: a larger request reads one more page with the same catalog.
                        more, following = await todoist._native(
                            native_tasks.page(env, cursor=following, limit=size - len(tasks), ids=ids, metadata=catalog)
                        )
                        tasks = [*tasks, *more]
                else:
                    tasks, following = await todoist.tasks(
                        coordinator, size, cursor, **({"ids": ",".join(ids)} if ids else {})
                    )
                if current["enabled"] and not backup.holds_ledger(env, coordinator.sql, now_s()):
                    await plus_week.remember_page(env, tasks, current["week_start"], current["labels"])
                response = {
                    "planning_tasks": [plus.task_view(task, current["today"], current["labels"]) for task in tasks],
                    "next_page_token": following,
                }
            else:
                response = await mutate(coordinator, method, request)
            # A native Todoist page asks for the BASIC view: the mapping without the weekly review's batch.
            if method in PLAN_METHODS and not (method == "ReadPlan" and message.view == pb.PlanView.BASIC):
                response = {"plan": {**response["plan"], **await review_targets(env, response["plan"]["week_start"])}}
            if method in PLAN_METHODS and native_tasks.enabled(env):
                # Pure rules use a local role projection; native clients see ordinary labels only.
                response = {"plan": {**response["plan"], "labels": []}}
            message = from_wire(response_type, response, strict=True).message
            return {"ok": json.dumps(to_wire(message), separators=(",", ":")), "next_cursor": None}
    except todoist.PlusError as error:
        reason = error.reason
    except (WireJsonError, ValueError, KeyError):
        reason = "BAD_REQUEST"
    except JsException:
        reason = "UNAVAILABLE"
    except Exception as error:
        print(json.dumps({"plus": "failed", "error_type": type(error).__name__}))
        reason = "INTERNAL"
    return {"error": reason, "detail": None, "retry_after": 30 if reason == "UNAVAILABLE" else None}
