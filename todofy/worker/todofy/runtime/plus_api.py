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

from todofy.core import plan as planning
from todofy.core import plus
from todofy.core.sql import gtd as gtd_sql
from todofy.core.sql import plus as sql
from todofy.runtime import backup, plan_store, plus_cache, plus_week
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
READ_METHODS = frozenset({"ReadPlan", "ListPlanningTasks", "ReadExtensionConnections", "VerifyPlanStore"})
PLAN_METHODS = frozenset({"ReadPlan", "ConfirmPlanMapping", "UpdatePlanLabels"})
# Writes of Todofy's planning store only, by value: no receipt, no Todoist write (set_dependency, resolve).
DEPENDENCY_METHODS = frozenset({"SetTaskDependency", "ResolveDependencies"})
METHODS = (
    READ_METHODS
    | OWNER_METHODS
    | DEPENDENCY_METHODS
    | {"SetTaskPlan", "SetTaskLead", "AppendTaskSteps", "CompleteTask", "UpdatePlanLabels"}
)
# Methods that write labels or bind them sync Todoist's labels first, so a label renamed in Todoist is never
# written back under its old name; every other call reads the metadata the object synced in the last five
# minutes (plus_todoist.metadata).
LABEL_WRITES = frozenset({"SetTaskPlan", "SetTaskLead", "UpdatePlanLabels", "ConfirmPlanMapping"})
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
        "hidden_filter_ids": plus.replaced_filters(metadata["filters"], discovered["labels"]),
    }


async def review_targets(env: Any, week: str) -> dict[str, Any]:
    """The weekly review's IDs, read with each Plan answer rather than with every task page or write:
    Todofy's mail project, the newest review task it created (this or the previous ISO week; the
    extension sees whether it is still open), the choices already kept for next week and every dependency."""
    monday = date.fromisoformat(week)
    statements = [
        env.DB.prepare(gtd_sql.REVIEW_WEEK.sql).bind("{:04d}-W{:02d}".format(*day.isocalendar()[:2]))
        for day in (monday, monday - timedelta(days=7))
    ]
    *reviews, chosen, edges = await env.DB.batch(
        [*statements, env.DB.prepare(sql.NEXT_WEEK).bind(week), plan_store.edges(env.DB)]
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
        "hidden_filter_ids": plus.replaced_filters(metadata["filters"], bindings),
    }
    mapping = json.dumps({"etag": updated["etag"], "labels": bindings}, separators=(",", ":"))
    await store.run(env.DB, sql.SAVE_SETTINGS, mapping, current["timezone"], current["week_start"])
    return {"plan": updated}


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


async def set_dependency(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """SetTaskDependency, under plus_lock. Adding reads both tasks once, to confirm they are active and to take
    the prerequisite's completed_count as the baseline; removing reads nothing. Either is a value write: an edge
    that is already there (or already gone) is answered without a write."""
    env = core.env
    await _dependencies_enabled(env)
    task_id, prerequisite_id = plus.check_id(request["task_id"]), plus.check_id(request["prerequisite_id"])
    if not request.get("waits"):
        return {"dependencies": await plan_store.remove_dependency(env.DB, plus.PROVIDER, task_id, prerequisite_id)}
    current = await plan_store.dependencies(env.DB)
    pairs = [(edge["task_id"], edge["prerequisite_id"]) for edge in current]
    if (task_id, prerequisite_id) in pairs:
        return {"dependencies": [edge for edge in current if edge["task_id"] == task_id]}
    # The extension greys out a cycle and stops at the limits; this is the check that holds across tabs.
    if planning.dependency_refusal(pairs, task_id, prerequisite_id):
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    tasks = await todoist.active(core, [task_id, prerequisite_id])
    if task_id not in tasks or prerequisite_id not in tasks:
        raise todoist.PlusError("NOT_FOUND")
    prerequisite = tasks[prerequisite_id]
    baseline = plus.completed_count(prerequisite)
    if baseline is None and plus.recurring(prerequisite):
        # Only the counter tells a recurring task's next completion apart: it never leaves the active list.
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    dependencies = await plan_store.add_dependency(
        env.DB, plus.PROVIDER, task_id, prerequisite_id, baseline or 0, now_s()
    )
    return {"dependencies": dependencies}


async def resolve_dependencies(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ResolveDependencies, under plus_lock: settles tasks that a complete read no longer listed, once Todoist
    confirms in one read that they are not active (a stale or partial read of the extension changes nothing).
    A prerequisite whose closing is not recorded costs one activity-log read, at most RESOLVE_ACTIVITY_READS per
    call; a failed one leaves it and the rest for the next check."""
    env = core.env
    await _dependencies_enabled(env)
    task_ids = list(dict.fromkeys(plus.check_id(task_id) for task_id in request.get("task_ids", [])))
    if not 1 <= len(task_ids) <= RESOLVE_IDS:
        raise todoist.PlusError("BAD_REQUEST")
    linked = await plan_store.dependency_roles(env.DB, plus.PROVIDER, task_ids)
    listed = await todoist.active(core, [row["id"] for row in linked]) if linked else {}
    gone = [row for row in linked if row["id"] not in listed]
    deleted = [row["id"] for row in gone if row["awaited"] and row["closed_as"] == planning.DELETED]
    completed: list[str] = []
    unknown = [row["id"] for row in gone if row["awaited"] and row["closed_as"] is None]
    for task_id in unknown[:RESOLVE_ACTIVITY_READS]:
        try:
            closed = await todoist.closed_as(core, task_id)
        except todoist.PlusError:
            break
        (completed if closed == planning.COMPLETED else deleted).append(task_id)
    dependencies, waiters = await plan_store.settle(
        env.DB,
        plus.PROVIDER,
        now_s(),
        gone=[row["id"] for row in gone if row["waits"]],
        completed=completed,
        deleted=deleted,
    )
    # A task that is gone itself needs no notice.
    gone_ids = {row["id"] for row in gone}
    return {
        "dependencies": dependencies,
        "dropped_task_ids": [task_id for task_id in waiters if task_id not in gone_ids],
    }


async def build_commands(
    core: Any, method: str, request: dict[str, Any], mapping: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    request_id = request["request_id"]
    task_id = plus.check_id(request.get("task_id") or request.get("parent_id", ""))
    if method == "CompleteTask":
        flow_date = request.get("flow_date", "")
        if flow_date and date.fromisoformat(flow_date).isoformat() != flow_date:
            raise todoist.PlusError("BAD_REQUEST")
        return [{"type": "item_close", "uuid": plus.command_id(request_id), "args": {"id": task_id}}]
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
    return [{"type": "item_update", "uuid": plus.command_id(request_id), "args": {"id": task_id, **args}}]


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
    current = await require_ready(core, await plan(core, fresh=synced), synced=synced)
    if previous and previous.plan_etag is not None and previous.plan_etag != current["etag"]:
        # Its frozen labels were chosen under another binding: resending them could attach a label by a name
        # that no longer has its role. The extension reads the task again.
        raise todoist.PlusError("ETAG_MISMATCH")
    if previous:
        commands = previous.commands
    else:
        if request.get("active") and not any(label["label"] == plus.ACTIVE for label in current["available_labels"]):
            # Todoist would create a label for an unknown name; Plus never creates one.
            raise todoist.PlusError("ACTION_NOT_ALLOWED")
        commands = await build_commands(core, method, request, current["labels"])
    await receipts.start(core, request_id, method, digest, commands, current["etag"] if synced else None)
    result = await todoist.commands(core, commands)
    if method in ("SetTaskPlan", "SetTaskLead"):
        # Every explicit new-week write replaces the membership; old resets cannot select it. A commitment
        # or Bet chosen on the week's last day is recorded for the next week, so Monday's reset keeps it.
        # Recorded from the labels just written, before the confirming read: if that read fails, the next
        # page scan would remember a Sunday choice under the ending week.
        written = commands[0]["args"]["labels"]
        names = plus.role_labels(current["labels"])
        marks = int(names["committed"] in written), int(names["bets"] in written)
        if any(marks):
            week = plus.membership_week(current["today"], current["week_start"], request)
            await store.run(env.DB, sql.REMEMBER_WEEK, request["task_id"], week, *marks)
        else:
            await store.run(env.DB, sql.FORGET_TASK, request["task_id"])
    if method == "CompleteTask":
        # Completed, not deleted, for every dependency on the task. A recurring task stays active, and the views
        # trust the active list first; what a completed task waited for goes once a complete read no longer
        # lists it (ResolveDependencies), so a recurring one keeps its dependencies.
        await plan_store.close_tasks(env.DB, plus.PROVIDER, [request["task_id"]], planning.COMPLETED, now_s())
        response = kept = {"task_id": request["task_id"]}
    elif method == "AppendTaskSteps":
        ids = result.get("temp_id_mapping", {})
        response = kept = {"task_ids": [str(ids.get(command["temp_id"], "")) for command in commands]}
        if not all(response["task_ids"]):
            raise todoist.PlusError("UNAVAILABLE")
    else:
        task = await todoist.task(core, request["task_id"])
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
            elif method == "ListPlanningTasks":
                current = await plan(coordinator)
                size = request.get("page_size", 0) or 100
                cursor = request.get("page_token", "")
                if not 1 <= size <= 200 or len(cursor) > 2048:
                    raise todoist.PlusError("BAD_REQUEST")
                tasks, following = await todoist.tasks(coordinator, size, cursor)
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
