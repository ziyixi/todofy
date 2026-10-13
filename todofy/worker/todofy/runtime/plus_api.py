"""Typed Plus RPC handlers inside the existing single-writer Durable Object."""

import hashlib
import json
import secrets
from datetime import date
from typing import Any

import js
from pyodide.ffi import JsException
from ziyixi_proto.todofy.ui.v1 import plus_service_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from todofy.core import plus
from todofy.core.sql import plus as sql
from todofy.runtime import backup, plus_week
from todofy.runtime import plus_store as store
from todofy.runtime import plus_todoist as todoist
from todofy.runtime.config import flag
from todofy.runtime.interop import now_s, to_js

OWNER_METHODS = frozenset(
    {"ConfirmPlanMapping", "IssueExtensionConnection", "ReadExtensionConnections", "RevokeExtensionConnection"}
)
READ_METHODS = frozenset({"ReadPlan", "ListPlanningTasks", "ReadExtensionConnections"})
METHODS = READ_METHODS | OWNER_METHODS | {"SetTaskPlan", "SetTaskLead", "AppendTaskSteps", "CompleteTask"}


def account_day(timezone: str) -> str:
    return str(
        js.Intl.DateTimeFormat.new(
            "en-CA", to_js({"timeZone": timezone, "year": "numeric", "month": "2-digit", "day": "2-digit"})
        ).format(js.Date.new(now_s() * 1000))
    )


async def plan(core: Any) -> dict[str, Any]:
    env = core.env
    metadata = await todoist.metadata(core)
    discovered = plus.discover(metadata["labels"], metadata["timezone"])
    current = await store.settings(env.DB)
    enabled = bool(current and current["enabled"] and json.loads(current["mapping"])["etag"] == discovered["etag"])
    today = account_day(metadata["timezone"])
    return {
        **discovered,
        "timezone": metadata["timezone"],
        "today": today,
        "week_start": plus.week_start(today),
        "enabled": enabled,
        "hidden_filter_ids": plus.replaced_filters(metadata["filters"]),
    }


async def require_ready(core: Any) -> dict[str, Any]:
    env = core.env
    current = await plan(core)
    if not current["enabled"]:
        raise todoist.PlusError("ACTION_NOT_ALLOWED")
    settings = await store.settings(env.DB)
    if settings["week_start"] != current["week_start"]:
        # New-week decisions wait for one bounded reset batch; they never inherit the old membership.
        if not await plus_week.reset_ended(core, current["week_start"]):
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
    await store.remember(env.DB, tasks, current["week_start"])
    await store.run(
        env.DB,
        sql.SAVE_SETTINGS,
        json.dumps({"etag": current["etag"], "labels": current["labels"]}),
        current["timezone"],
        current["week_start"],
    )
    current["enabled"] = True
    return {"plan": current}


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


async def build_commands(core: Any, method: str, request: dict[str, Any]) -> list[dict[str, Any]]:
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
    if request.get("etag") != plus.task_etag(task):
        raise todoist.PlusError("ETAG_MISMATCH")
    args = (
        {"labels": plus.plan_labels(task, request)}
        if method == "SetTaskPlan"
        else plus.lead_args(task, request.get("deadline", ""), request.get("lead_days", 0))
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
        commands = await build_commands(core, method, request)
        await store.start_action(env.DB, request_id, digest, commands)
    result = await todoist.commands(core, commands)
    if method == "CompleteTask":
        response = {"task_id": request["task_id"]}
    elif method == "AppendTaskSteps":
        ids = result.get("temp_id_mapping", {})
        response = {"task_ids": [str(ids.get(command["temp_id"], "")) for command in commands]}
        if not all(response["task_ids"]):
            raise todoist.PlusError("UNAVAILABLE")
    else:
        task = await todoist.task(core, request["task_id"])
        response = {"task": plus.task_view(task, current["today"])}
        # Every explicit new-week write replaces the membership; old resets cannot select it.
        await store.run(
            env.DB,
            sql.REMEMBER_WEEK,
            str(task["id"]),
            current["week_start"],
            int("committed" in task.get("labels", [])),
            int("bets" in task.get("labels", [])),
        )
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
            elif method == "ListPlanningTasks":
                current = await plan(coordinator)
                size = request.get("page_size", 0) or 100
                cursor = request.get("page_token", "")
                if not 1 <= size <= 200 or len(cursor) > 2048:
                    raise todoist.PlusError("BAD_REQUEST")
                tasks, following = await todoist.tasks(coordinator, size, cursor)
                if current["enabled"] and not backup.holds_ledger(env, coordinator.sql, now_s()):
                    await plus_week.remember_page(env, tasks, current["week_start"])
                response = {
                    "planning_tasks": [plus.task_view(task, current["today"]) for task in tasks],
                    "next_page_token": following,
                }
            else:
                response = await mutate(coordinator, method, request)
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
