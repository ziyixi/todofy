"""TodofyCoordinator (`inbox-v1`): the single writer of the ledger and its serial executor.

Internal routes on https://coordinator (only the Worker's own stub reaches them):

    POST /ingest      webhook bytes -> 204 | 400 | 409 | 413 | 503
    POST /wake        run the alarm loop now -> 204
    POST /reconcile   owner action -> EventDetail | error
    POST /report      compute one report now -> report | error
    GET  /event/<id>  EventDetail (parses the stored mail, so it runs here)
    GET  /state       budgets and the next alarm, for the Overview

Each alarm runs at most one ledger step (summary, task creation, lookup or
completion), then any due reminder, report and retention ticks (v2 plan §5.3).
DO SQLite holds only counters and schedule times that may be lost: every
time then defaults to "due now" and the ledger stays in D1.
"""

import hashlib
import json
import math
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from pyodide.ffi import JsException
from workers import DurableObject, Response

from todofy.core import gemini_wire, prompts
from todofy.core.api_errors import ApiError
from todofy.core.backoff import (
    BACKOFF_BASE,
    DAY,
    GEMINI_STEP_BUDGET,
    HOUR,
    LOOKUP_MAX_PAGES,
    MINUTE,
    TODOIST_AUTH_BLOCK,
    TODOIST_MAX_ATTEMPTS,
    TODOIST_STEP_BUDGET,
    WATCHDOG,
    postpone_delay,
    retry_delay,
    summary_gives_up,
)
from todofy.core.classify import TaskResult, classify_lookup
from todofy.core.contract import MAX_EVENT_BYTES, UUID, ContractError, MailEvent, parse_mail_event
from todofy.core.render import clean_summary, content_notice, render_todo_body, task_title
from todofy.core.request_id import todoist_request_id
from todofy.core.sql import views
from todofy.core.todoist_request import RequestTooLarge, build_task_request
from todofy.core.vocab import Code, EventState, Reconcile, allowed_actions
from todofy.runtime import api, gemini, ledger, reminder, reports, retention, todoist
from todofy.runtime.config import flag, gemini_models, integer, source_id, var
from todofy.runtime.http import empty, error, json_response, with_headers
from todofy.runtime.interop import now_ms, now_s, read_capped, sha256_hex
from todofy.runtime.ledger import WORKER, CompletedSummary, EventRow, OwnerAction

DEFAULT_TOKEN_BUDGET = 3_000_000
DEFAULT_LOOKUP_DELAY_MS = 2 * MINUTE * 1000
DEFAULT_BACKOFF_BASE_MS = BACKOFF_BASE * 1000
DEFAULT_WATCHDOG_MS = WATCHDOG * 1000
# Room for the model's answer on top of the prompt estimate (v2 plan §5.3 step A).
OUTPUT_TOKEN_ALLOWANCE = 4096
MAX_SUMMARY_BYTES = 64 << 10
# An automatic footer lookup that fails is retried with backoff about an hour, then left to the owner.
LOOKUP_MAX_ATTEMPTS = 6
TODOIST_WINDOW = 15 * MINUTE
TODOIST_WINDOW_LIMIT = 1000
# The most calls one ledger step can make: a whole footer lookup.
TODOIST_STEP_CALLS = max(TODOIST_MAX_ATTEMPTS, LOOKUP_MAX_PAGES)
REPORT_HOURLY_LIMIT = 30
TIMELINE_LIMIT = 100
TICK_RETRY = 10 * MINUTE
RETENTION_CONTINUE = MINUTE
USAGE_KEEP_DAYS = 7

DO_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS control (id INTEGER PRIMARY KEY CHECK (id = 1),"
    " next_reminder_check INTEGER NOT NULL DEFAULT 0, next_report INTEGER NOT NULL DEFAULT 0,"
    " next_maintenance INTEGER NOT NULL DEFAULT 0, todoist_blocked_until INTEGER NOT NULL DEFAULT 0)",
    "INSERT INTO control (id) VALUES (1) ON CONFLICT DO NOTHING",
    "CREATE TABLE IF NOT EXISTS llm_usage (day TEXT PRIMARY KEY, reserved_tokens INTEGER NOT NULL DEFAULT 0,"
    " used_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS todoist_calls (minute_bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS report_requests (hour_bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL)",
)
WRITE_ROUTES = frozenset({"/ingest", "/reconcile", "/report"})
TICK_COLUMNS = ("next_reminder_check", "next_report", "next_maintenance")
SET_CONTROL = {
    column: f"UPDATE control SET {column} = ? WHERE id = 1" for column in (*TICK_COLUMNS, "todoist_blocked_until")
}


def _day(now: int) -> str:
    return datetime.fromtimestamp(now, UTC).strftime("%Y-%m-%d")


def _log(**fields: Any) -> None:
    # IDs, states and codes only: never mail content or upstream bodies.
    print(json.dumps(fields))


def _request_hash(fields: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _report_error(status: int, code: str, now: int) -> Response:
    response = error(status, ApiError(code))
    if status == 429:
        # The hourly computation cap resets at the next UTC hour.
        return with_headers(response, {"retry-after": str(HOUR - now % HOUR)})
    return response


def _after(seconds: float) -> int:
    """The D1 deadline ``seconds`` from now, rounded up so a wait (e.g. Retry-After) is never cut short."""
    return math.ceil(now_ms() / 1000 + seconds)


def _utf8_prefix(text: str, limit: int) -> str:
    return text.encode()[:limit].decode(errors="ignore")


class TodofyCoordinator(DurableObject):
    def __init__(self, ctx: Any, env: Any) -> None:
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        for statement in DO_SCHEMA:
            self.sql.exec(statement)
        self.running = False
        # A wake-up that arrived while the alarm loop was busy; honoured when it finishes.
        self.woken = False

    # ---- routes -------------------------------------------------------------------------

    async def fetch(self, request: Any) -> Response:
        path = urlsplit(request.url).path
        if request.method == "POST" and path in WRITE_ROUTES and flag(self.env, "MAINTENANCE_MODE"):
            # The Worker refuses these first; this keeps the single writer consistent on its own.
            return error(503, ApiError.MAINTENANCE)
        try:
            match request.method, path:
                case "POST", "/ingest":
                    return await self.ingest(request)
                case "POST", "/wake":
                    await self.wake()
                    return empty()
                case "POST", "/reconcile":
                    return await self.reconcile(await request.json())
                case "POST", "/report":
                    return await self.report(await request.json())
                case "GET", "/state":
                    return await self.state()
            if request.method == "GET" and path.startswith("/event/"):
                return await self.event(path.removeprefix("/event/"))
        except JsException:
            # D1 or storage failed; the platform logs carry the details.
            return error(503, ApiError.UNAVAILABLE)
        return error(404, ApiError.NOT_FOUND)

    async def ingest(self, request: Any) -> Response:
        body = await read_capped(request.js_object.body, MAX_EVENT_BYTES)
        if body is None:
            return error(413, ApiError.PAYLOAD_TOO_LARGE)
        key = request.headers.get("idempotency-key") or ""
        try:
            event = parse_mail_event(body)
        except ContractError as exc:
            _log(ingest="rejected", reason=exc.reason)
            return error(400, ApiError.INVALID_PAYLOAD)
        # A repeated header arrives joined with ", " and never equals a UUID.
        if key != event.event_id:
            _log(ingest="rejected", reason="idempotency_key")
            return error(400, ApiError.INVALID_PAYLOAD)
        digest = await sha256_hex(body)
        stored = await ledger.ingest(self.env.DB, source_id(self.env), event.event_id, body.decode(), digest, now_s())
        _log(ingest=stored, event_id=event.event_id)
        if stored == ledger.Stored.CONFLICT:
            return error(409, ApiError.EVENT_CONFLICT)
        if stored == ledger.Stored.NEW:
            await self.wake()
        return empty()

    async def wake(self) -> None:
        """Run the alarm loop as soon as possible."""
        if self.running:
            self.woken = True
            return
        current = await self.ctx.storage.getAlarm()
        now = now_ms()
        if current is None or current > now:
            await self.ctx.storage.setAlarm(now)

    async def reconcile(self, command: dict[str, Any]) -> Response:
        owner, event_id = command.get("owner"), command.get("event_id")
        action, version = command.get("action"), command.get("version")
        action_request_id, task_id = command.get("action_request_id"), command.get("task_id")
        if (
            not isinstance(owner, str)
            or not owner
            or not isinstance(event_id, str)
            or not UUID.fullmatch(event_id)
            or action not in set(Reconcile)
            or type(version) is not int
            or not isinstance(action_request_id, str)
            or not UUID.fullmatch(action_request_id)
            or (action == Reconcile.TASK_CREATED) != isinstance(task_id, str)
        ):
            return error(400, ApiError.INVALID_REQUEST)
        db, now = self.env.DB, now_s()
        request_hash = _request_hash({"event_id": event_id, "action": action, "version": version, "task_id": task_id})
        claim = await ledger.find_action(db, owner, action_request_id, request_hash)
        if claim.claim == ledger.Claim.CONFLICT:
            return error(409, ApiError.ACTION_REQUEST_CONFLICT)
        if claim.claim == ledger.Claim.REPLAY:
            return await self.event(event_id)
        row = await ledger.get(db, source_id(self.env), event_id)
        if row is None:
            return error(404, ApiError.NOT_FOUND)
        if row.version != version:
            return error(409, ApiError.VERSION_CONFLICT)
        if action not in allowed_actions(row.state, row.last_error_code):
            return error(409, ApiError.ACTION_NOT_ALLOWED)
        recorded = OwnerAction(owner, action_request_id, action, request_hash)
        match action:
            case Reconcile.TASK_CREATED:
                # The alarm then completes it, like a task found by the lookup.
                to, code, columns = EventState.TODO_CREATED, "", {"task_id": task_id, "next_attempt_at": now}
            case Reconcile.TASK_NOT_CREATED:
                # A footer lookup runs first; only if it finds nothing is the frozen request resent.
                to, code, columns = EventState.TODO_UNKNOWN, "", {"attempt_count": 0, "next_attempt_at": now}
            case Reconcile.RETRY_SUMMARY:
                to, code = EventState.PENDING, ""
                columns = {"attempt_count": 0, "crashes": 0, "next_attempt_at": now}
            case _:
                to, code, columns = EventState.IGNORED, Code.DISMISSED_BY_OWNER, {"next_attempt_at": 0}
        moved = await ledger.transition(db, row, to, actor=ledger.OWNER, now=now, code=code, action=recorded, **columns)
        if moved is None:
            return error(409, ApiError.VERSION_CONFLICT)
        _log(reconcile=action, event_id=event_id, state=to)
        await self.wake()
        return await self.event(event_id)

    async def report(self, command: dict[str, Any]) -> Response:
        kind, top_n, budget_ms = command.get("kind"), command.get("top_n"), command.get("budget_ms")
        owner, action_request_id = command.get("owner"), command.get("action_request_id")
        if (
            kind not in (reports.SUMMARY, reports.RECOMMENDATION)
            or type(top_n) is not int
            or not 0 <= top_n <= 10
            or type(budget_ms) is not int
            or budget_ms <= 0
            or (owner is None) != (action_request_id is None)
            or not isinstance(owner or "", str)
            or not isinstance(action_request_id or "", str)
        ):
            return error(400, ApiError.INVALID_REQUEST)
        db, now = self.env.DB, now_s()
        if owner is not None:
            claim = await ledger.claim_action(
                db, owner, action_request_id, "recompute", _request_hash({"kind": kind, "top_n": top_n}), now
            )
            if claim.claim == ledger.Claim.CONFLICT:
                return error(409, ApiError.ACTION_REQUEST_CONFLICT)
            if claim.claim == ledger.Claim.REPLAY:
                return self._replayed_report(claim)
        status, result = await self._compute_report(kind, top_n, now, budget_ms)
        if owner is not None:
            stored = json.dumps(result, ensure_ascii=False) if status == 200 else result
            await ledger.finish_action(db, owner, action_request_id, stored, status)
        return json_response(result) if status == 200 else _report_error(status, result, now)

    async def _compute_report(self, kind: str, top_n: int, now: int, budget_ms: int) -> tuple[int, Any]:
        try:
            return 200, await reports.compute(self.env, self, kind, top_n, now, budget_ms)
        except reports.ReportError as exc:
            return exc.status, exc.code
        except Exception as exc:
            _log(report="failed", kind=kind, top_n=top_n, error=type(exc).__name__)
            return 503, ApiError.UNAVAILABLE

    @staticmethod
    def _replayed_report(claim: ledger.ActionClaim) -> Response:
        if claim.http_status is None:
            # Still running, or the run that claimed it was evicted: ask for a new action.
            return error(503, ApiError.UNAVAILABLE)
        if claim.http_status == 200:
            return json_response(json.loads(claim.result_ref or "null"))
        return _report_error(claim.http_status, claim.result_ref or ApiError.UNAVAILABLE, now_s())

    async def event(self, event_id: str) -> Response:
        if not UUID.fullmatch(event_id):
            return error(404, ApiError.NOT_FOUND)
        db = self.env.DB
        row = await ledger.get(db, source_id(self.env), event_id)
        if row is None:
            return error(404, ApiError.NOT_FOUND)
        now = now_s()
        timeline, summary, legacy = await db.batch(
            [
                db.prepare(views.TIMELINE.sql).bind(event_id, TIMELINE_LIMIT),
                db.prepare(views.SUMMARY_OF_EVENT.sql).bind(event_id),
                db.prepare(views.LEGACY_TEXT_READABLE.sql).bind(event_id, now),
            ]
        )
        cached = summary.results[0] if summary.results else None
        event = self._stored_event(row)
        detail = api.event_summary(asdict(row), now) | {
            "version": row.version,
            "crashes": row.crashes,
            "subject": event.subject if event else (cached["subject"] if cached else None),
            "from": event.from_addresses[0].address if event and event.from_addresses else None,
            "summary": row.summary or (cached["summary"] if cached else "") or None,
            "summary_model": row.summary_model or (cached["model"] if cached else "") or None,
            "todo_body": row.todo_body or None,
            "todoist_request_id": row.todoist_request_id or None,
            "allowed_actions": list(allowed_actions(row.state, row.last_error_code)),
            "transitions": [
                {
                    "at": api.timestamp(int(step["at"])),
                    "from_state": step["from_state"],
                    "to_state": step["to_state"],
                    "error_code": step["error_code"] or None,
                    "actor": step["actor"],
                }
                for step in timeline.results
            ],
            "has_legacy_text": bool(legacy.results),
        }
        return json_response(detail)

    async def state(self) -> Response:
        now = now_s()
        usage = self._usage(now)
        blocked_until = self._control()["todoist_blocked_until"]
        alarm = await self.ctx.storage.getAlarm()
        return json_response(
            {
                "next_alarm_at": None if alarm is None else api.timestamp(int(alarm) // 1000),
                "gemini": {
                    "day": _day(now),
                    "token_budget": self._token_budget(),
                    "reserved_tokens": usage["reserved_tokens"],
                    "used_tokens": usage["used_tokens"],
                    "calls": usage["calls"],
                    "models": gemini_models(self.env),
                },
                "todoist": {
                    "blocked_until": api.timestamp(blocked_until) if blocked_until > now else None,
                    "window_seconds": TODOIST_WINDOW,
                    "window_calls": self._todoist_window_calls(now),
                    "window_limit": TODOIST_WINDOW_LIMIT,
                },
            }
        )

    # ---- budgets (also used by reports.py) ------------------------------------------------

    def reserve_tokens(self, tokens: int, now: int) -> bool:
        """Reserve Gemini tokens for one call against the UTC day's budget."""
        day = _day(now)
        self.sql.exec("INSERT INTO llm_usage (day) VALUES (?) ON CONFLICT DO NOTHING", day)
        self.sql.exec("DELETE FROM llm_usage WHERE day < ?", _day(now - USAGE_KEEP_DAYS * DAY))
        cursor = self.sql.exec(
            "UPDATE llm_usage SET reserved_tokens = reserved_tokens + ?"
            " WHERE day = ? AND reserved_tokens + used_tokens + ? <= ?",
            tokens,
            day,
            tokens,
            self._token_budget(),
        )
        return cursor.rowsWritten > 0

    def settle_tokens(self, reserved: int, used: int, now: int) -> None:
        """Replace a reservation with the tokens the call really used."""
        day = _day(now)
        self.sql.exec("INSERT INTO llm_usage (day) VALUES (?) ON CONFLICT DO NOTHING", day)
        self.sql.exec(
            "UPDATE llm_usage SET reserved_tokens = max(reserved_tokens - ?, 0), used_tokens = used_tokens + ?,"
            " calls = calls + 1 WHERE day = ?",
            reserved,
            used,
            day,
        )

    def take_report_slot(self, now: int) -> bool:
        """One of the REPORT_HOURLY_LIMIT on-demand report computations per UTC hour."""
        hour = now // HOUR
        self.sql.exec("DELETE FROM report_requests WHERE hour_bucket < ?", hour)
        self.sql.exec("INSERT INTO report_requests (hour_bucket, count) VALUES (?, 0) ON CONFLICT DO NOTHING", hour)
        cursor = self.sql.exec(
            "UPDATE report_requests SET count = count + 1 WHERE hour_bucket = ? AND count < ?",
            hour,
            REPORT_HOURLY_LIMIT,
        )
        return cursor.rowsWritten > 0

    def _count_todoist_calls(self, calls: int, now: int) -> None:
        """Count calls against Todoist's 1000 per 15 minutes before making them (an upper bound)."""
        self.sql.exec(
            "INSERT INTO todoist_calls (minute_bucket, count) VALUES (?, ?)"
            " ON CONFLICT (minute_bucket) DO UPDATE SET count = count + excluded.count",
            now // MINUTE,
            calls,
        )

    def _todoist_window_calls(self, now: int) -> int:
        first = (now - TODOIST_WINDOW) // MINUTE + 1
        self.sql.exec("DELETE FROM todoist_calls WHERE minute_bucket < ?", first)
        rows = self.sql.exec("SELECT coalesce(sum(count), 0) AS n FROM todoist_calls").toArray()
        return int(rows[0].n)

    def _usage(self, now: int) -> dict[str, int]:
        rows = self.sql.exec(
            "SELECT reserved_tokens, used_tokens, calls FROM llm_usage WHERE day = ?", _day(now)
        ).toArray()
        if not rows:
            return {"reserved_tokens": 0, "used_tokens": 0, "calls": 0}
        return {name: int(getattr(rows[0], name)) for name in ("reserved_tokens", "used_tokens", "calls")}

    def _token_budget(self) -> int:
        return integer(self.env, "GEMINI_DAILY_TOKEN_BUDGET", DEFAULT_TOKEN_BUDGET)

    def _control(self) -> dict[str, int]:
        row = self.sql.exec("SELECT * FROM control WHERE id = 1").toArray()[0]
        return {name: int(getattr(row, name)) for name in (*TICK_COLUMNS, "todoist_blocked_until")}

    def _todoist_wait(self, now: int) -> int | None:
        """None when Todoist may be called now; otherwise when to look again (0: at the next wake-up)."""
        if flag(self.env, "FORCE_PAUSE_TODOIST"):
            return 0
        blocked_until = self._control()["todoist_blocked_until"]
        if blocked_until > now:
            return blocked_until
        if self._todoist_window_calls(now) + TODOIST_STEP_CALLS > TODOIST_WINDOW_LIMIT:
            return now + MINUTE
        return None

    def _ms(self, name: str, default: int) -> int:
        return integer(self.env, name, default)

    # ---- alarm loop -----------------------------------------------------------------------

    async def alarm(self, alarm_info: Any = None) -> None:
        if self.running:
            self.woken = True
            return
        self.running, self.woken = True, False
        try:
            await self._run()
        finally:
            self.running = False

    async def _run(self) -> None:
        storage, env = self.ctx.storage, self.env
        if flag(env, "MAINTENANCE_MODE"):
            await storage.setAlarm(now_ms() + DAY * 1000)
            return
        now = now_s()
        await self._arm_watchdog()
        await ledger.recover_interrupted(env.DB, now, lookup_at=_after(self._lookup_delay()))
        worked = False
        if not flag(env, "PROCESSING_PAUSED"):
            worked = await self._step(now, todoist_open=self._todoist_wait(now) is None)
        await self._ticks()
        await storage.setAlarm(await self._next_alarm_ms(worked))

    async def _arm_watchdog(self) -> None:
        """Written before every external call, so an evicted run is resumed."""
        await self.ctx.storage.setAlarm(now_ms() + self._ms("WATCHDOG_MS", DEFAULT_WATCHDOG_MS))

    async def _step(self, now: int, *, todoist_open: bool) -> bool:
        """At most one unit of ledger work; whether there was any."""
        db = self.env.DB
        row = await ledger.next_due(db, now, todoist=todoist_open)
        if row is not None:
            match row.state:
                case EventState.PENDING:
                    await self._summarize(row, now)
                case EventState.SUMMARIZED:
                    await self._create_task(row, now)
                case _:
                    await self._complete(row, now)
            return True
        if todoist_open and (row := await ledger.next_lookup(db, now)) is not None:
            await self._lookup(row, now)
            return True
        return False

    def _stored_event(self, row: EventRow) -> MailEvent | None:
        if row.payload is None:
            return None
        try:
            return parse_mail_event(row.payload.encode())
        except ContractError:
            return None

    def _backoff_base(self) -> float:
        return self._ms("BACKOFF_BASE_MS", DEFAULT_BACKOFF_BASE_MS) / 1000

    def _lookup_delay(self) -> float:
        return self._ms("LOOKUP_DELAY_MS", DEFAULT_LOOKUP_DELAY_MS) / 1000

    def _retry_at(self, attempts: int, retry_after: float = 0.0) -> int:
        return _after(postpone_delay(attempts, retry_after, self._backoff_base()))

    async def _summarize(self, row: EventRow, now: int) -> None:
        db = self.env.DB
        event = self._stored_event(row)
        if event is None or event.unreadable:
            # Imported rows may carry a body the current contract rejects; retrying cannot help either.
            code = Code.MAIL_NEEDS_REVIEW if event else Code.INVALID_SAVED_EVENT
            await ledger.transition(
                db, row, EventState.FAILED_SUMMARY, actor=WORKER, now=now, code=code, next_attempt_at=0
            )
            return
        content, preface = gemini_wire.summary_content(event), content_notice(event)
        reserved = math.ceil(len((prompts.SUMMARY_EMAIL + preface + content).encode()) / 2) + OUTPUT_TOKEN_ALLOWANCE
        if not self.reserve_tokens(reserved, now):
            tomorrow = now - now % DAY + DAY
            await ledger.transition(
                db,
                row,
                EventState.PENDING,
                actor=WORKER,
                now=now,
                code=Code.LLM_BUDGET_EXHAUSTED,
                next_attempt_at=tomorrow,
            )
            return
        running = await ledger.transition(db, row, EventState.SUMMARIZING, actor=WORKER, now=now)
        if running is None:
            self.settle_tokens(reserved, 0, now)
            return
        result = await gemini.generate(
            self.env,
            system=prompts.SUMMARY_EMAIL,
            user=content,
            preface=preface,
            deadline_ms=now_ms() + GEMINI_STEP_BUDGET * 1000,
        )
        done = now_s()
        self.settle_tokens(reserved, result.tokens, done)
        verdict = result.verdict
        if verdict.ok:
            summary = clean_summary(_utf8_prefix(result.text, MAX_SUMMARY_BYTES), event)
            body = render_todo_body(event, summary)
            sender = event.from_addresses[0].address if event.from_addresses else ""
            await ledger.transition(
                db,
                running,
                EventState.SUMMARIZED,
                actor=WORKER,
                now=done,
                summary=summary,
                summary_model=result.model,
                todo_body=body,
                todoist_request_id=todoist_request_id(task_title(event), body, sender),
                attempt_count=0,
                next_attempt_at=done,
            )
            return
        code, attempts = verdict.code or Code.SUMMARY_FAILED, running.attempt_count
        if summary_gives_up(attempts, code, done - row.created_at):
            to, next_at = EventState.FAILED_SUMMARY, 0
        else:
            to, next_at = EventState.PENDING, self._retry_at(attempts, verdict.retry_after)
        await ledger.transition(
            db, running, to, actor=WORKER, now=done, code=code, attempt_count=attempts + 1, next_attempt_at=next_at
        )

    async def _create_task(self, row: EventRow, now: int) -> None:
        db, env = self.env.DB, self.env
        event = self._stored_event(row)
        if event is None:
            await ledger.transition(
                db, row, EventState.FAILED_SUMMARY, actor=WORKER, now=now, code=Code.INVALID_SAVED_EVENT
            )
            return
        try:
            request = build_task_request(
                task_title(event),
                row.todo_body,
                var(env, "TODOIST_DEFAULT_PROJECT_ID"),
                row.todoist_request_id,
                var(env, "TODOIST_API_KEY"),
            )
        except RequestTooLarge:
            await self._retry_task_later(row, Code.TODOIST_REJECTED, 0.0, now)
            return
        sending = await ledger.transition(db, row, EventState.TODO_SENDING, actor=WORKER, now=now)
        if sending is None:
            return
        self._count_todoist_calls(TODOIST_MAX_ATTEMPTS, now)
        result = await todoist.create_task(env, request, budget_ms=TODOIST_STEP_BUDGET * 1000)
        verdict, done = result.verdict, now_s()
        _log(task=verdict.result, event_id=row.event_id, code=verdict.code)
        match verdict.result:
            case TaskResult.CREATED:
                completed = CompletedSummary(event.subject, row.summary, row.summary_model, result.task_id)
                await ledger.transition(
                    db,
                    sending,
                    EventState.COMPLETE,
                    actor=WORKER,
                    now=done,
                    completed=completed,
                    task_id=result.task_id,
                    attempt_count=0,
                    next_attempt_at=0,
                )
            case TaskResult.UNKNOWN:
                lookup_at = _after(self._lookup_delay())
                await ledger.transition(
                    db,
                    sending,
                    EventState.TODO_UNKNOWN,
                    actor=WORKER,
                    now=done,
                    code=verdict.code or Code.TODO_RESULT_UNKNOWN,
                    attempt_count=0,
                    next_attempt_at=lookup_at,
                )
            case TaskResult.BLOCKED:
                blocked_until = done + TODOIST_AUTH_BLOCK
                self.sql.exec(SET_CONTROL["todoist_blocked_until"], blocked_until)
                await ledger.transition(
                    db,
                    sending,
                    EventState.SUMMARIZED,
                    actor=WORKER,
                    now=done,
                    code=Code.TODOIST_AUTH_BLOCKED,
                    next_attempt_at=blocked_until,
                )
            case TaskResult.RETRY_LATER:
                code = verdict.code or Code.TODOIST_UNAVAILABLE
                await self._retry_task_later(sending, code, verdict.retry_after, done)

    async def _retry_task_later(self, row: EventRow, code: str, retry_after: float, now: int) -> None:
        await ledger.transition(
            self.env.DB,
            row,
            EventState.SUMMARIZED,
            actor=WORKER,
            now=now,
            code=code,
            attempt_count=row.attempt_count + 1,
            next_attempt_at=self._retry_at(row.attempt_count, retry_after),
        )

    async def _complete(self, row: EventRow, now: int) -> None:
        """todo_created -> complete: the task exists, record it for the reports."""
        event = self._stored_event(row)
        completed = CompletedSummary(event.subject if event else "", row.summary, row.summary_model, row.task_id)
        await ledger.transition(
            self.env.DB, row, EventState.COMPLETE, actor=WORKER, now=now, completed=completed, next_attempt_at=0
        )

    async def _lookup(self, row: EventRow, now: int) -> None:
        """Read-only footer lookup for a todo_unknown row (v2 plan §5.3 step B′)."""
        db = self.env.DB
        confirmed = await ledger.owner_confirmed_resend(db, row.event_id)
        self._count_todoist_calls(LOOKUP_MAX_PAGES, now)
        found = await todoist.find_footer_tasks(self.env, row.event_id)
        state, code = classify_lookup(None if found is None else len(found))
        done, attempts = now_s(), row.attempt_count + 1
        _log(lookup=code or state, event_id=row.event_id, owner_confirmed=confirmed)
        if state == EventState.TODO_CREATED:
            await ledger.transition(
                db, row, state, actor=WORKER, now=done, task_id=found[0], attempt_count=0, next_attempt_at=done
            )
        elif code == Code.LOOKUP_NOT_FOUND and confirmed:
            # The owner confirmed no task exists and the lookup agrees: resend the frozen request.
            await ledger.transition(
                db, row, EventState.SUMMARIZED, actor=WORKER, now=done, attempt_count=0, next_attempt_at=done
            )
        else:
            retry = code == Code.LOOKUP_FAILED and not confirmed and attempts < LOOKUP_MAX_ATTEMPTS
            next_at = _after(retry_delay(row.attempt_count, self._backoff_base())) if retry else 0
            await ledger.transition(
                db, row, state, actor=WORKER, now=done, code=code, attempt_count=attempts, next_attempt_at=next_at
            )

    async def _ticks(self) -> None:
        """Reminder, report precompute and retention, each when its control time is due."""
        control = self._control()
        for column in TICK_COLUMNS:
            now = now_s()
            if control[column] > now:
                continue
            await self._arm_watchdog()
            try:
                next_at = await self._tick(column, now)
            except Exception as exc:
                # One failing tick must not stall the ledger or the other ticks.
                _log(tick=column, error=type(exc).__name__)
                next_at = now + TICK_RETRY
            self.sql.exec(SET_CONTROL[column], next_at)

    async def _tick(self, column: str, now: int) -> int:
        match column:
            case "next_reminder_check":
                return await reminder.tick(self.env, self, now)
            case "next_report":
                return await reports.tick(self.env, self, now)
            case _:
                more = await retention.tick(self.env.DB, self.env, now)
                return now + (RETENTION_CONTINUE if more else DAY)

    async def _next_alarm_ms(self, worked: bool) -> int:
        soon = now_ms() + 1000
        if worked or self.woken:
            return soon  # keep draining
        now = now_s()
        control = self._control()
        times = [control[column] for column in TICK_COLUMNS]
        if not flag(self.env, "PROCESSING_PAUSED"):
            wait = self._todoist_wait(now)
            if wait:
                times.append(wait)
            due = await ledger.next_wake_at(self.env.DB, todoist=wait is None)
            if due is not None:
                times.append(due)
        return max(min(times) * 1000, soon)
