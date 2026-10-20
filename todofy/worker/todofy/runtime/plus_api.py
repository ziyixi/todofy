"""Typed PlusService handlers inside the existing single-writer Durable Object: Tasks' Mail page and the weekly
review's two Todofy facts. Planning is Tasks' own (tasks/worker/src/planning.ts)."""

import json
from datetime import date, timedelta
from typing import Any

from pyodide.ffi import JsException
from ziyixi_proto.todofy.ui.v1 import plus_service_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from todofy.core import mailbox
from todofy.core.sql import gtd as gtd_sql
from todofy.core.sql import mailbox as mailbox_sql
from todofy.runtime import backup, plus_mail, plus_tasks
from todofy.runtime.config import flag
from todofy.runtime.interop import now_s

READ_METHODS = frozenset({"ReadWeeklyReview", "ListMailItems", "ReadMailSummary", "ReadMailSettings"})
# A write of D1 alone, by compare-and-set: resending it is safe by its value, so it carries no request ID.
VALUE_WRITES = frozenset({"UpdateMailCategories"})
# What Tasks calls on its Planning channel (the gateway's allowlist, todofy/gateway/src/plus.ts NATIVE_METHODS).
METHODS = READ_METHODS | VALUE_WRITES | {"ConvertMailItem", "DeleteMailSummaries"}


async def weekly_review(env: Any, request: dict[str, Any]) -> dict[str, Any]:
    """ReadWeeklyReview: the two facts of Plan's weekly review Todofy keeps, for the account week Tasks' Plan names. One
    D1 batch of two statements and no Tasks call: the newest review task created for that or the previous ISO week,
    and the Mail entries still pending."""
    monday = date.fromisoformat(request.get("week_start", ""))
    if monday.isoformat() != request["week_start"] or monday.weekday() != 0:
        raise plus_tasks.PlusError("BAD_REQUEST")
    weeks = ["{:04d}-W{:02d}".format(*day.isocalendar()[:2]) for day in (monday, monday - timedelta(days=7))]
    review, pending = await env.DB.batch(
        [env.DB.prepare(gtd_sql.LATEST_REVIEW_TASK.sql).bind(*weeks), env.DB.prepare(mailbox_sql.NATIVE_COUNT.sql)]
    )
    return {
        "review_task_id": next((str(dict(row)["task_id"]) for row in review.results), ""),
        "mailbox_pending_count": int(dict(pending.results[0])["n"]),
    }


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
                mailbox.action_id(request.get("request_id", ""))
        async with coordinator.plus_lock:
            env = coordinator.env
            if method not in READ_METHODS and backup.holds_ledger(env, coordinator.sql, now_s()):
                raise plus_tasks.PlusError("MAINTENANCE")
            if method == "ReadWeeklyReview":
                response = await weekly_review(env, request)
            elif method == "ListMailItems":
                response = await plus_mail.list_items(coordinator, request)
            elif method == "ReadMailSummary":
                response = await plus_mail.read_summary(coordinator, request)
            elif method == "ReadMailSettings":
                response = await plus_mail.read_settings(coordinator)
            elif method == "UpdateMailCategories":
                response = await plus_mail.update_categories(coordinator, request)
            elif method == "ConvertMailItem":
                response = await plus_mail.convert(coordinator, request)
            else:
                response = await plus_mail.delete_summaries(coordinator, request)
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
