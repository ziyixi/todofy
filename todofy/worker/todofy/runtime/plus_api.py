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

from todofy.core import plus
from todofy.core.sql import gtd as gtd_sql
from todofy.core.sql import plus as sql
from todofy.runtime import backup, plus_week
from todofy.runtime import plus_store as store
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.config import flag, var
from todofy.runtime.interop import now_s, to_js

OWNER_METHODS = frozenset(
    {"ConfirmPlanMapping", "IssueExtensionConnection", "ReadExtensionConnections", "RevokeExtensionConnection"}
)
READ_METHODS = frozenset({"ReadPlan", "ListPlanningTasks", "ReadExtensionConnections"})
PLAN_METHODS = frozenset({"ReadPlan", "ConfirmPlanMapping", "UpdatePlanLabels"})
METHODS = (
    READ_METHODS | OWNER_METHODS | {"SetTaskPlan", "SetTaskLead", "AppendTaskSteps", "CompleteTask", "UpdatePlanLabels"}
)


def account_day(timezone: str) -> str:
    return str(
        js.Intl.DateTimeFormat.new(
            "en-CA", to_js({"timeZone": timezone, "year": "numeric", "month": "2-digit", "day": "2-digit"})
        ).format(js.Date.new(now_s() * 1000))
    )


async def plan(core: Any, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    env = core.env
    metadata = metadata if metadata is not None else await todoist.metadata(core)
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
    extension sees whether it is still open) and the choices already kept for next week."""
    monday = date.fromisoformat(week)
    statements = [
        env.DB.prepare(gtd_sql.REVIEW_WEEK.sql).bind("{:04d}-W{:02d}".format(*day.isocalendar()[:2]))
        for day in (monday, monday - timedelta(days=7))
    ]
    *reviews, chosen = await env.DB.batch([*statements, env.DB.prepare(sql.NEXT_WEEK).bind(week)])
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
    }


async def require_ready(core: Any, current: dict[str, Any] | None = None) -> dict[str, Any]:
    env = core.env
    current = current if current is not None else await plan(core)
    if not current["enabled"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    settings = await store.settings(env.DB)
    if settings["week_start"] != current["week_start"]:
        # New-week decisions wait for one bounded reset batch; they never inherit the old membership.
        if not await plus_week.reset_ended(core, current["week_start"], current["labels"]):
            raise todoist.PlusError("UNAVAILABLE")
        await store.run(env.DB, sql.ADVANCE_WEEK, current["week_start"])
    return current


async def confirm(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    env = core.env
    current = await plan(core)
    if current["etag"] != request["etag"]:
        raise todoist.PlusError("ETAG_MISMATCH")
    if current["missing_labels"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    if current["enabled"]:
        # A repeated setup must still settle an ended week, never adopt its marks as fresh decisions.
        return {"plan": await require_ready(core)}
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


async def update_labels(core: Any, request: dict[str, Any]) -> dict[str, Any]:
    env = core.env
    request_id = request["request_id"]
    digest = plus.fingerprint(["UpdatePlanLabels", request])
    previous = await store.first(env.DB, sql.ACTION, request_id)
    if previous:
        if previous["request_hash"] != digest:
            raise todoist.PlusError("BAD_REQUEST")
        if previous["response"] is not None:
            return json.loads(previous["response"])
        raise todoist.PlusError("UNAVAILABLE")
    metadata = await todoist.metadata(core)
    current = await plan(core, metadata)
    if request["etag"] != current["etag"]:
        raise todoist.PlusError("ETAG_MISMATCH")
    bindings = plus.replace_planning_labels(current["labels"], request["labels"], current["available_labels"])
    # Settle old-week work using its old binding identities before changing configuration.
    current = await require_ready(core, current)
    updated = {
        **current,
        "labels": bindings,
        "etag": plus.fingerprint([bindings, current["timezone"]]),
        "hidden_filter_ids": plus.replaced_filters(metadata["filters"], bindings),
    }
    mapping = json.dumps({"etag": updated["etag"], "labels": bindings}, separators=(",", ":"))
    response = {"plan": updated}
    # Configuration and its immutable receipt commit together; a lost response cannot replay an older config.
    await env.DB.batch(
        [
            env.DB.prepare(sql.START_ACTION).bind(request_id, digest, mapping, now_s()),
            env.DB.prepare(sql.SAVE_SETTINGS).bind(mapping, current["timezone"], current["week_start"]),
            env.DB.prepare(sql.FINISH_ACTION).bind(json.dumps(response, separators=(",", ":")), request_id),
        ]
    )
    return response


async def connections(env: Any, method: str, request: dict[str, Any]) -> dict[str, Any]:
    if method == "ReadExtensionConnections":
        rows = await store.rows(env.DB, sql.CONNECTIONS)
        return {"connections": [{**row, "revoked": bool(row["revoked"])} for row in rows]}
    if method == "RevokeExtensionConnection":
        await store.run(env.DB, sql.REVOKE_CONNECTION, plus.check_id(request["connection_id"]))
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
    await store.run(
        env.DB,
        sql.CREATE_CONNECTION,
        request["request_id"],
        display_name,
        hashlib.sha256(token.encode()).hexdigest(),
        now_s(),
    )
    return {"connection": {"id": request["request_id"], "display_name": display_name, "revoked": False}, "token": token}


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


async def mutate(core: Any, method: str, request: dict[str, Any]) -> dict[str, Any]:
    env = core.env
    request_id = request["request_id"]
    digest = plus.fingerprint([method, request])
    previous = await store.first(env.DB, sql.ACTION, request_id)
    if previous:
        if previous["request_hash"] != digest:
            raise todoist.PlusError("BAD_REQUEST")
        if previous["response"] is not None:
            return json.loads(previous["response"])
    current = await require_ready(core)
    if previous:
        commands = json.loads(previous["commands"])
    else:
        if request.get("active") and not any(label["label"] == plus.ACTIVE for label in current["available_labels"]):
            # Todoist would create a label for an unknown name; Plus never creates one.
            raise todoist.PlusError("ACTION_NOT_ALLOWED")
        commands = await build_commands(core, method, request, current["labels"])
        await store.start_action(env.DB, request_id, digest, commands)
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
        response = {"task_id": request["task_id"]}
    elif method == "AppendTaskSteps":
        ids = result.get("temp_id_mapping", {})
        response = {"task_ids": [str(ids.get(command["temp_id"], "")) for command in commands]}
        if not all(response["task_ids"]):
            raise todoist.PlusError("UNAVAILABLE")
    else:
        task = await todoist.task(core, request["task_id"])
        response = {"task": plus.task_view(task, current["today"], current["labels"])}
    await store.run(env.DB, sql.FINISH_ACTION, json.dumps(response, separators=(",", ":")), request_id)
    return response


async def handle(coordinator: Any, method: str, text: str, *, owner: bool) -> dict[str, Any]:
    try:
        if method not in METHODS or (method in OWNER_METHODS and not owner):
            raise todoist.PlusError("UNAUTHORIZED")
        request_type = getattr(pb, method + "Request")
        response_type = getattr(pb, method + "Response")
        request = to_wire(from_wire(request_type, json.loads(text), strict=True).message)
        if method not in READ_METHODS:
            if flag(coordinator.env, "MAINTENANCE_MODE"):
                raise todoist.PlusError("MAINTENANCE")
            plus.action_id(request.get("request_id", ""))
        async with coordinator.plus_lock:
            env = coordinator.env
            if method not in READ_METHODS and backup.holds_ledger(env, coordinator.sql, now_s()):
                raise todoist.PlusError("MAINTENANCE")
            if method in {"IssueExtensionConnection", "ReadExtensionConnections", "RevokeExtensionConnection"}:
                response = await connections(env, method, request)
            elif method == "ReadPlan":
                response = {"plan": await plan(coordinator)}
            elif method == "ConfirmPlanMapping":
                response = await confirm(coordinator, request)
            elif method == "UpdatePlanLabels":
                response = await update_labels(coordinator, request)
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
            if method in PLAN_METHODS:
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
