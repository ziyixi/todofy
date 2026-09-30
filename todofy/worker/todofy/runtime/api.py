"""Owner API routes under /api/v1 (api/owner-api-v1.openapi.yaml), served inside the coordinator.

The gateway has already checked Access, CSRF and MAINTENANCE_MODE and passes the
canonical owner with the request (coordinator.owner_api); it answers /api/v1/csrf
itself and composes /api/v1/setup from its own facts and :func:`setup`.
Everything else runs here, in the Durable Object (30 s of CPU), which is also
the single writer of the ledger.
"""

import base64
import binascii
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, unquote

from todofy.core.api_errors import ApiError
from todofy.core.backoff import DAY
from todofy.core.contract import UUID
from todofy.core.render import rfc3339
from todofy.core.report_schema import MAX_TOP_N
from todofy.core.sql import ACTIVE_STATES, views
from todofy.core.vocab import (
    ALWAYS_ATTENTION_STATES,
    ATTENTION_AGE_SECONDS,
    TERMINAL_STATES,
    EventState,
    Reconcile,
)
from todofy.runtime import backup, gtd, metrics, reminder, reports
from todofy.runtime.config import flag, report_default_top, source_id, var
from todofy.runtime.http import Result, failed, ok
from todofy.runtime.interop import now_ms, read_capped

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
MAX_CURSOR_CHARS = 256
MAX_BODY_BYTES = 16 << 10
# Beyond any timestamp or version, yet still passed to D1 as a JS Number (larger
# ints become BigInt, which D1 rejects).
MAX_INTEGER = 2**52
NEWEST_FIRST_START = (MAX_INTEGER, "")
OLDEST_FIRST_START = (-1, "")

LEGACY_ID = re.compile(r"legacy:[0-9A-Za-z-]{1,128}")
TASK_ID = re.compile(r"[0-9A-Za-z_-]{1,64}")
DAY_CURSOR = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
EVENT_PATH = re.compile(r"/api/v1/events/([^/]+)")
RECONCILE_PATH = re.compile(r"/api/v1/events/([^/]+)/reconcile")
LEGACY_TEXT_PATH = re.compile(r"/api/v1/legacy_text/([^/]+)")

# The states of sql.DUE: the Worker acts on them at next_attempt_at (0 = since arrival).
DUE_STATES = frozenset({EventState.PENDING, EventState.SUMMARIZED, EventState.TODO_CREATED})
REPORT_KINDS = frozenset({"summary", "recommendation"})
# additionalProperties: false in ReconcileRequest and RecomputeRequest.
RECONCILE_REQUIRED = frozenset({"action", "version", "action_request_id"})
RECONCILE_FIELDS = RECONCILE_REQUIRED | {"task_id"}
RECOMPUTE_REQUIRED = frozenset({"kind", "action_request_id"})
RECOMPUTE_FIELDS = RECOMPUTE_REQUIRED | {"top"}


class InvalidRequest(Exception):
    """A query or body the OpenAPI contract rejects: 400 invalid_request."""


@dataclass(frozen=True)
class OwnerRequest:
    """One /api/v1 request as the gateway passes it over RPC."""

    method: str
    path: str
    # The query string without "?".
    query: str
    # The declared Content-Length, checked before the body is read.
    content_length: str | None
    # The unread JS ReadableStream of a write, or None.
    body: Any


def timestamp(seconds: int) -> str:
    return rfc3339(datetime.fromtimestamp(seconds, UTC))


def event_summary(row: Mapping[str, Any], now: int) -> dict[str, Any]:
    """One mail_events row (views.EVENT_SUMMARY columns or more) as an OpenAPI EventSummary."""
    state = row["state"]
    if state in DUE_STATES:
        next_attempt: str | None = timestamp(max(row["next_attempt_at"], row["created_at"]))
    elif state == EventState.TODO_UNKNOWN and row["next_attempt_at"] > 0:
        next_attempt = timestamp(row["next_attempt_at"])  # the scheduled footer lookup
    else:
        next_attempt = None
    return {
        "event_id": row["event_id"],
        "state": state,
        "error_code": row["last_error_code"] or None,
        "attempt_count": row["attempt_count"],
        "task_id": row["task_id"] or None,
        "received_at": timestamp(row["created_at"]),
        "updated_at": timestamp(row["updated_at"]),
        "next_attempt_at": next_attempt,
        "attention": state in ALWAYS_ATTENTION_STATES
        or (state not in TERMINAL_STATES and row["created_at"] <= now - ATTENTION_AGE_SECONDS),
        "imported": bool(row["imported"]),
    }


def _query(request: OwnerRequest) -> dict[str, str]:
    pairs = parse_qs(request.query, keep_blank_values=True)
    if any(len(values) > 1 for values in pairs.values()):
        raise InvalidRequest
    return {name: values[0] for name, values in pairs.items()}


def _limit(value: str | None) -> int:
    if value is None:
        return DEFAULT_LIMIT
    if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= MAX_LIMIT:
        raise InvalidRequest
    return int(value)


def _encode_cursor(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).rstrip(b"=").decode()


def _decode_cursor(value: str) -> str:
    if len(value) > MAX_CURSOR_CHARS:
        raise InvalidRequest
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError):
        raise InvalidRequest from None


def _event_cursor(value: str | None, start: tuple[int, str]) -> tuple[int, str]:
    if value is None:
        return start
    created_at, _, event_id = _decode_cursor(value).partition(":")
    if not created_at.isascii() or not created_at.isdigit() or int(created_at) > MAX_INTEGER:
        raise InvalidRequest
    if not UUID.fullmatch(event_id):
        raise InvalidRequest
    return int(created_at), event_id


async def _json_body(request: OwnerRequest) -> dict[str, Any]:
    length = request.content_length
    if length and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
        raise InvalidRequest
    # A chunked body has no Content-Length: stop reading past the cap instead of buffering it all in
    # the object, which also runs ingest and the alarm loop.
    raw = await read_capped(request.body, MAX_BODY_BYTES)
    if raw is None:
        raise InvalidRequest
    try:
        body = json.loads(raw)
    except ValueError:
        raise InvalidRequest from None
    if not isinstance(body, dict):
        raise InvalidRequest
    return body


def _integer(value: Any, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise InvalidRequest
    return value


def _action_request_id(body: Mapping[str, Any]) -> str:
    value = body.get("action_request_id")
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise InvalidRequest
    return value


def _path_id(match: re.Match[str], *, legacy: bool = False) -> str | None:
    """The decoded path parameter, or None when it cannot name a row (→ 404)."""
    value = unquote(match.group(1))
    if UUID.fullmatch(value) or (legacy and LEGACY_ID.fullmatch(value)):
        return value
    return None


async def overview(env: Any, coordinator: Any) -> Result:
    now = now_ms() // 1000
    db, source = env.DB, source_id(env)
    counts, attention, received, due = await db.batch(
        [
            db.prepare(views.ACTIVE_COUNTS.sql).bind(source),
            db.prepare(views.ATTENTION_COUNT.sql).bind(source, now - ATTENTION_AGE_SECONDS),
            db.prepare(views.RECEIVED_SINCE.sql).bind(source, now - DAY),
            db.prepare(views.OLDEST_DUE.sql).bind(now),
        ]
    )
    # next_alarm_at and the Gemini/Todoist budgets live in the coordinator's storage, in API shape.
    budgets = await coordinator.budgets()
    latest_reminders, _ = await reminder.page(db, None, 1)
    per_state = {row["state"]: row["n"] for row in counts.results}
    oldest_due = due.results[0]["at"]
    return ok(
        {
            "build": var(env, "BUILD_SHA", "unknown"),
            "now": timestamp(now),
            "flags": {
                "maintenance_mode": flag(env, "MAINTENANCE_MODE"),
                "processing_paused": flag(env, "PROCESSING_PAUSED"),
                "force_pause_todoist": flag(env, "FORCE_PAUSE_TODOIST"),
                "reminder_enabled": flag(env, "REMINDER_ENABLED"),
            },
            "counts": {state: per_state.get(state, 0) for state in ACTIVE_STATES},
            "attention_count": attention.results[0]["n"],
            "received_24h": received.results[0]["n"],
            "latest_reminder": latest_reminders[0] if latest_reminders else None,
            "next_alarm_at": budgets["next_alarm_at"],
            "oldest_due_at": None if oldest_due is None else timestamp(oldest_due),
            "gemini": budgets["gemini"],
            "todoist": budgets["todoist"],
            "backup": backup.overview(env, coordinator.sql, now),
        }
    )


async def events(env: Any, query: dict[str, str]) -> Result:
    now = now_ms() // 1000
    db, source = env.DB, source_id(env)
    limit = _limit(query.get("limit"))
    view, state = query.get("view", "recent"), query.get("state")
    if view == "attention":
        if state is not None:
            raise InvalidRequest
        created_at, event_id = _event_cursor(query.get("cursor"), OLDEST_FIRST_START)
        statement = db.prepare(views.ATTENTION_PAGE.sql).bind(
            source, now - ATTENTION_AGE_SECONDS, created_at, event_id, limit + 1
        )
    elif view == "recent":
        created_at, event_id = _event_cursor(query.get("cursor"), NEWEST_FIRST_START)
        if state is None:
            statement = db.prepare(views.RECENT_PAGE.sql).bind(source, created_at, event_id, limit + 1)
        elif state in set(EventState):
            statement = db.prepare(views.RECENT_PAGE_BY_STATE.sql).bind(source, state, created_at, event_id, limit + 1)
        else:
            raise InvalidRequest
    else:
        raise InvalidRequest
    rows = (await statement.all()).results
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = _encode_cursor(f"{last['created_at']}:{last['event_id']}")
    return ok({"items": [event_summary(row, now) for row in rows[:limit]], "next_cursor": next_cursor})


async def reconcile(request: OwnerRequest, coordinator: Any, owner: str, event_id: str) -> Result:
    body = await _json_body(request)
    if not RECONCILE_REQUIRED <= body.keys() <= RECONCILE_FIELDS:
        raise InvalidRequest
    action = body["action"]
    if action not in set(Reconcile):
        raise InvalidRequest
    version = _integer(body["version"], 1, MAX_INTEGER)
    action_request_id = _action_request_id(body)
    task_id = None
    if action == Reconcile.TASK_CREATED:
        task_id = body.get("task_id")
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
            raise InvalidRequest
    elif "task_id" in body:
        raise InvalidRequest
    return await coordinator.reconcile(owner, event_id, action, version, action_request_id, task_id)


async def recompute(request: OwnerRequest, env: Any, coordinator: Any, owner: str) -> Result:
    body = await _json_body(request)
    if not RECOMPUTE_REQUIRED <= body.keys() <= RECOMPUTE_FIELDS:
        raise InvalidRequest
    kind = body["kind"]
    if kind not in REPORT_KINDS or (kind == "summary" and "top" in body):
        raise InvalidRequest
    top_n = 0
    if kind == "recommendation":
        top_n = _integer(body["top"], 1, MAX_TOP_N) if "top" in body else report_default_top(env)
    return await coordinator.recompute(owner, _action_request_id(body), kind, top_n)


async def reminders(env: Any, query: dict[str, str]) -> Result:
    limit = _limit(query.get("limit"))
    before_day = None
    if (cursor := query.get("cursor")) is not None:
        before_day = _decode_cursor(cursor)
        if not DAY_CURSOR.fullmatch(before_day):
            raise InvalidRequest
    items, next_day = await reminder.page(env.DB, before_day, limit)
    return ok({"items": items, "next_cursor": _encode_cursor(next_day) if next_day else None})


async def daily_metrics(env: Any, query: dict[str, str]) -> Result:
    """GET /api/v1/metrics/daily?days=: finished UTC days from daily_metrics, oldest first."""
    value = query.get("days")
    days = metrics.DEFAULT_API_DAYS
    if value is not None:
        if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= metrics.MAX_API_DAYS:
            raise InvalidRequest
        days = int(value)
    return ok(await metrics.daily(env.DB, days, now_ms() // 1000))


async def gtd_daily(env: Any, query: dict[str, str]) -> Result:
    """GET /api/v1/gtd/daily?days=: the GTD ledger's daily aggregates up to today, oldest first."""
    value = query.get("days")
    days = gtd.DEFAULT_API_DAYS
    if value is not None:
        if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= gtd.MAX_API_DAYS:
            raise InvalidRequest
        days = int(value)
    return ok(await gtd.daily(env.DB, days, now_ms() // 1000))


async def legacy_text(env: Any, key: str) -> Result:
    """GET /api/v1/legacy_text/{key}: imported texts reach 1.9 MB, fine for the object's 30 s of CPU."""
    row = await env.DB.prepare(views.LEGACY_TEXT.sql).bind(key).first()
    expires_at = None if row is None else row["expires_at"]
    if row is None or (expires_at is not None and expires_at <= now_ms() // 1000):
        return failed(404, ApiError.NOT_FOUND)
    return ok(
        {
            "event_id": row["event_id"],
            "created_at": timestamp(row["created_at"]),
            "expires_at": None if expires_at is None else timestamp(expires_at),
            "text": row["text"],
        }
    )


def setup(env: Any) -> dict[str, Any]:
    """The core's facts for the setup page (the gateway adds its own): whether each secret is set, never its value."""
    return {
        "mail_source_id": source_id(env),
        "configured": {
            "gemini_api_key": bool(var(env, "GEMINI_API_KEY")),
            "todoist_api_key": bool(var(env, "TODOIST_API_KEY")),
            "todoist_project": bool(var(env, "TODOIST_DEFAULT_PROJECT_ID")),
        },
    }


async def _route(request: OwnerRequest, env: Any, coordinator: Any, owner: str) -> Result:
    method, path = request.method, request.path
    match method, path:
        case "GET", "/api/v1/overview":
            return await overview(env, coordinator)
        case "GET", "/api/v1/events":
            return await events(env, _query(request))
        case "GET", "/api/v1/reminders":
            return await reminders(env, _query(request))
        case "GET", "/api/v1/metrics/daily":
            return await daily_metrics(env, _query(request))
        case "GET", "/api/v1/gtd/daily":
            return await gtd_daily(env, _query(request))
        case "GET", "/api/v1/reports/latest":
            return ok(await reports.latest(env.DB))
        case "POST", "/api/v1/reports/recompute":
            return await recompute(request, env, coordinator, owner)
    if method == "GET" and (match := EVENT_PATH.fullmatch(path)):
        event_id = _path_id(match)
        if event_id is None:
            return failed(404, ApiError.NOT_FOUND)
        return await coordinator.event(event_id)
    if method == "POST" and (match := RECONCILE_PATH.fullmatch(path)):
        event_id = _path_id(match)
        if event_id is None:
            return failed(404, ApiError.NOT_FOUND)
        return await reconcile(request, coordinator, owner, event_id)
    if method == "GET" and (match := LEGACY_TEXT_PATH.fullmatch(path)):
        key = _path_id(match, legacy=True)
        if key is None:
            return failed(404, ApiError.NOT_FOUND)
        return await legacy_text(env, key)
    return failed(404, ApiError.NOT_FOUND)


async def handle(request: OwnerRequest, env: Any, coordinator: Any, owner: str) -> Result:
    """Every /api/v1/* path the gateway forwards (it answers csrf and setup itself: 404 here)."""
    try:
        return await _route(request, env, coordinator, owner)
    except InvalidRequest:
        return failed(400, ApiError.INVALID_REQUEST)
