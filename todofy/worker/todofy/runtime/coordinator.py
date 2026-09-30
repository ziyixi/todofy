"""TodofyCore (`inbox-v1`): the single writer of the ledger and its serial executor.

It runs in the `todofy-core` Worker and is reached only through the gateway's
COORDINATOR binding, which calls these methods over JS RPC after its own checks
(docs/gateway-contract.md §3). Each answers with a ``http.Result`` as a dict:

    ingest(idempotency_key, body)          webhook bytes -> 204 | 400 | 409 | 413 | 503
    wake()                                 run the alarm loop now (the gateway's cron) -> None
    newsletter(kind, query)                stored or on-demand report (Basic auth passed)
    newsletter_auth_failure()              count a failed Basic credential -> 401 | 429
    owner_api(owner, method, path, ...)    the owner API (api.py) for the Access owner
    setup()                                the core's facts for the setup page -> dict
    ops_status() / ops_set_guard(json) /   the gateway's ``Ops`` entrypoint (contracts/ops-v1):
    ops_canary_result(id) / ops_report(json)   {"ok": value} or {"error": OpsErrorCode}

``fetch`` answers 404: the object has no HTTP routes. For this one release it
answers the previous, fetch-based gateway 503 with Retry-After (see ``fetch``).

Everything that reads D1, parses mail or calls Gemini/Todoist runs here: a
Durable Object invocation has 30 s of CPU, a Worker request 10 ms on Workers Free.

Each alarm runs at most one ledger step (summary, task creation, lookup or
completion), then any due reminder, report and retention ticks (v2 plan §5.3).
A canary event (contracts/ops-v1) takes the same summary step and then ends:
it never reaches Todoist, the reports, the attention list or the reminder.
An ops guard (``shed``) defers only the weekly backup, retention and the
metrics rollup, each within its own bound (runtime/ops.py).
DO SQLite holds only counters and schedule times that may be lost: every
time then defaults to "due now" and the ledger stays in D1.
"""

import hashlib
import json
import math
from collections.abc import Awaitable
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from pyodide.ffi import JsException
from workers import DurableObject, Response

from todofy.core import gemini_wire, prompts
from todofy.core import ops as ops_rules
from todofy.core.api_errors import ApiError
from todofy.core.backoff import (
    BACKOFF_BASE,
    DAY,
    GEMINI_STEP_BUDGET,
    HOUR,
    LOOKUP_MAX_PAGES,
    MINUTE,
    REPORT_ON_DEMAND_BUDGET,
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
from todofy.core.metrics import Step, StepPoint
from todofy.core.render import clean_summary, content_notice, render_todo_body, task_title
from todofy.core.request_id import todoist_request_id
from todofy.core.sql import views
from todofy.core.todoist_request import RequestTooLarge, build_task_request
from todofy.core.vocab import Code, EventState, Reconcile, allowed_actions
from todofy.runtime import api, backup, gemini, gtd, ledger, metrics, ops, reminder, reports, retention, todoist
from todofy.runtime.config import flag, gemini_models, integer, source_id, var
from todofy.runtime.http import NO_CONTENT, Result, failed, not_found, ok
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
# A canary's summary step is tried at most this often before it ends ignored (failed).
CANARY_MAX_ATTEMPTS = 3
CANARY_TRANSIENT = frozenset({Code.SUMMARY_FAILED, Code.LLM_QUOTA})
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
    # Failed precompute attempts per report and UTC day (reports.tick caps them).
    "CREATE TABLE IF NOT EXISTS report_failures (kind TEXT NOT NULL, top_n INTEGER NOT NULL, day TEXT NOT NULL,"
    " count INTEGER NOT NULL, PRIMARY KEY (kind, top_n, day))",
    # Summary reservations whose Gemini call is in flight: settled by the step itself, or
    # by the next alarm after an eviction (counted as spent, like reports._generate).
    "CREATE TABLE IF NOT EXISTS llm_inflight (event_id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved INTEGER NOT NULL)",
)
MAX_OWNER_CHARS = 254
NEWSLETTER_KINDS = frozenset({reports.SUMMARY, reports.RECOMMENDATION})
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


def _after(seconds: float) -> int:
    """The D1 deadline ``seconds`` from now, rounded up so a wait (e.g. Retry-After) is never cut short."""
    return math.ceil(now_ms() / 1000 + seconds)


def _utf8_prefix(text: str, limit: int) -> str:
    return text.encode()[:limit].decode(errors="ignore")


class TodofyCore(DurableObject):
    def __init__(self, ctx: Any, env: Any) -> None:
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        for statement in (*DO_SCHEMA, *backup.DO_SCHEMA, *metrics.DO_SCHEMA, *ops.DO_SCHEMA, *gtd.DO_SCHEMA):
            self.sql.exec(statement)
        self.running = False
        # A wake-up that arrived while the alarm loop was busy; honoured when it finishes.
        self.woken = False

    # ---- RPC methods (the gateway's COORDINATOR binding) -------------------------------------

    async def fetch(self, request: Any) -> Response:
        # The object has no HTTP surface: the gateway calls the RPC methods below.
        return not_found()

    @staticmethod
    async def _answer(work: Awaitable[Result]) -> dict[str, Any]:
        """``work``'s Result as an RPC return value; a D1 or storage failure is 503 unavailable."""
        try:
            return (await work).wire()
        except JsException:
            # The platform logs carry the details.
            return failed(503, ApiError.UNAVAILABLE).wire()

    async def ingest(self, idempotency_key: str | None, body: Any) -> dict[str, Any]:
        """POST /hooks/mail after the gateway's checks: the Idempotency-Key header and the unread body stream."""
        # The gateway refuses writes in maintenance first; this keeps the single writer consistent on its own.
        if flag(self.env, "MAINTENANCE_MODE"):
            return failed(503, ApiError.MAINTENANCE).wire()
        return await self._answer(self._ingest(idempotency_key or "", body))

    async def newsletter(self, kind: str, query: str) -> dict[str, Any]:
        """GET /api/<kind> with ``query`` (without "?") after the gateway accepted the Basic credential."""
        if kind not in NEWSLETTER_KINDS:
            return failed(404, ApiError.NOT_FOUND).wire()
        return await self._answer(reports.serve(self.env, self, kind, query))

    async def newsletter_auth_failure(self) -> dict[str, Any]:
        """A newsletter request whose Basic credential the gateway rejected."""
        return await self._answer(reports.count_auth_failure(self.env.DB, now_s()))

    async def owner_api(
        self, owner: str, method: str, path: str, query: str, content_length: str | None, body: Any
    ) -> dict[str, Any]:
        """One /api/v1 request for the canonical owner the gateway verified with Access."""
        if "@" not in owner or len(owner) > MAX_OWNER_CHARS:
            return failed(401, ApiError.UNAUTHORIZED).wire()
        if method == "POST" and flag(self.env, "MAINTENANCE_MODE"):
            return failed(503, ApiError.MAINTENANCE).wire()
        if method == "POST" and backup.holds_ledger(self.env, self.sql, now_s()):
            # A backup job keeps the ledger still for a minute or so (at most its lease).
            return failed(503, ApiError.UNAVAILABLE).wire()
        request = api.OwnerRequest(method, path, query, content_length, body)
        return await self._answer(api.handle(request, self.env, self, owner))

    def setup(self) -> dict[str, Any]:
        """The core's facts for the setup page (never secret values)."""
        return api.setup(self.env)

    # ---- ops-v1 (the gateway's Ops entrypoint; contracts/ops-v1) ------------------------------
    # Each returns {"ok": value} or {"error": OpsErrorCode} and never raises. They also work in
    # maintenance mode: status reports it, setGuard and reportOps write only object storage.

    @staticmethod
    def _ops_error(code: ops_rules.OpsError) -> dict[str, Any]:
        return {"error": str(code)}

    async def ops_status(self) -> dict[str, Any]:
        now = now_s()
        try:
            return {"ok": await ops.status(self.env, self, now)}
        except Exception as exc:
            # D1 or storage failed: report it as a value (health "down"), never throw.
            _log(ops="status_unavailable", error=type(exc).__name__)
            return {"ok": ops.unavailable(self.env, self.sql, now)}

    async def ops_set_guard(self, input_json: str) -> dict[str, Any]:
        try:
            wanted = ops_rules.guard_input(ops_rules.loads(input_json), now_ms())
            state, released = ops.set_guard(self.sql, wanted, now_ms())
            if released:
                # Jobs the guard deferred are due again (run, or deferred under a new guard).
                now = now_s()
                self.sql.exec("UPDATE control SET next_maintenance = min(next_maintenance, ?) WHERE id = 1", now)
                metrics.set_next_flush(self.sql, min(metrics.next_flush(self.sql), now))
                gtd.release(self.sql, now)
                await self.wake()
        except ops_rules.InvalidInput:
            return self._ops_error(ops_rules.OpsError.INVALID_INPUT)
        except Exception as exc:
            _log(ops="set_guard_failed", error=type(exc).__name__)
            return self._ops_error(ops_rules.OpsError.UNAVAILABLE)
        _log(ops="guard", level=state["level"], reason=state["reason"])
        return {"ok": state}

    async def ops_canary_result(self, event_id: str) -> dict[str, Any]:
        try:
            checked = ops_rules.event_id(event_id)
            return {"ok": await ops.canary(self.env, self.sql, checked, now_s())}
        except ops_rules.InvalidInput:
            return self._ops_error(ops_rules.OpsError.INVALID_INPUT)
        except Exception as exc:
            _log(ops="canary_result_failed", error=type(exc).__name__)
            return self._ops_error(ops_rules.OpsError.UNAVAILABLE)

    async def ops_report(self, report_json: str) -> dict[str, Any]:
        now = now_s()
        try:
            received = ops_rules.report(ops_rules.loads(report_json), now)
            result = ops.store_report(self.sql, received, now)
            if result["stored"]:
                # A day whose reminder is not created yet considers the new report at once (on its
                # own it is due only from the UTC day after it was generated; reminder._ops_due).
                self.sql.exec("UPDATE control SET next_reminder_check = min(next_reminder_check, ?) WHERE id = 1", now)
                await self.wake()
        except ops_rules.InvalidInput:
            return self._ops_error(ops_rules.OpsError.INVALID_INPUT)
        except Exception as exc:
            _log(ops="report_failed", error=type(exc).__name__)
            return self._ops_error(ops_rules.OpsError.UNAVAILABLE)
        _log(ops="report", stored=result["stored"], items=result["item_count"])
        return {"ok": result}

    def latest_ops_report(self) -> ops_rules.Report | None:
        """The dashboard's latest report, for the reminder's ops digest (reminder.tick)."""
        return ops.latest_report(self.sql)

    def gtd_facts(self) -> Any:
        """The GTD ledger's facts for ops status() (core.gtd.GtdFacts, object storage only)."""
        return gtd.facts(self.env, self.sql)

    def usage_facts(self, now: int) -> dict[str, int]:
        """The Gemini and Todoist budgets as numbers, for ops status()."""
        usage = self._usage(now)
        return {
            **usage,
            "token_budget": self._token_budget(),
            "todoist_blocked_until": self._control()["todoist_blocked_until"],
            "todoist_window_calls": self._todoist_window_calls(now),
            "todoist_window_limit": TODOIST_WINDOW_LIMIT,
        }

    async def _ingest(self, key: str, stream: Any) -> Result:
        body = await read_capped(stream, MAX_EVENT_BYTES)
        if body is None:
            return failed(413, ApiError.PAYLOAD_TOO_LARGE)
        try:
            event = parse_mail_event(body)
        except ContractError as exc:
            _log(ingest="rejected", reason=exc.reason)
            return failed(400, ApiError.INVALID_PAYLOAD)
        # A repeated header arrives joined with ", " and never equals a UUID.
        if key != event.event_id:
            _log(ingest="rejected", reason="idempotency_key")
            return failed(400, ApiError.INVALID_PAYLOAD)
        digest = await sha256_hex(body)
        stored = await ledger.ingest(
            self.env.DB, source_id(self.env), event.event_id, body.decode(), digest, now_s(), event.canary_run_id
        )
        _log(ingest=stored, event_id=event.event_id, canary=event.canary_run_id is not None)
        if stored == ledger.Stored.CONFLICT:
            return failed(409, ApiError.EVENT_CONFLICT)
        if stored == ledger.Stored.NEW:
            await self.wake()
        return NO_CONTENT

    async def wake(self) -> None:
        """Run the alarm loop as soon as possible."""
        if self.running:
            self.woken = True
            return
        current = await self.ctx.storage.getAlarm()
        now = now_ms()
        if current is None or current > now:
            await self.ctx.storage.setAlarm(now)

    async def reconcile(
        self, owner: str, event_id: str, action: str, version: int, action_request_id: str, task_id: str | None
    ) -> Result:
        """An owner action on one event (api.reconcile validated the request)."""
        db, now = self.env.DB, now_s()
        request_hash = _request_hash({"event_id": event_id, "action": action, "version": version, "task_id": task_id})
        claim = await ledger.find_action(db, owner, action_request_id, request_hash)
        if claim.claim == ledger.Claim.CONFLICT:
            return failed(409, ApiError.ACTION_REQUEST_CONFLICT)
        if claim.claim == ledger.Claim.REPLAY:
            return await self.event(event_id)
        row = await ledger.get(db, source_id(self.env), event_id)
        if row is None:
            return failed(404, ApiError.NOT_FOUND)
        if row.version != version:
            return failed(409, ApiError.VERSION_CONFLICT)
        if action not in allowed_actions(row.state, row.last_error_code, canary=row.canary):
            return failed(409, ApiError.ACTION_NOT_ALLOWED)
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
            return failed(409, ApiError.VERSION_CONFLICT)
        _log(reconcile=action, event_id=event_id, state=to)
        await self.wake()
        return await self.event(event_id)

    async def recompute(self, owner: str, action_request_id: str, kind: str, top_n: int) -> Result:
        """The owner's report recompute, replayed by action_request_id (api.recompute validated it)."""
        db, now = self.env.DB, now_s()
        claim = await ledger.claim_action(
            db, owner, action_request_id, "recompute", _request_hash({"kind": kind, "top_n": top_n}), now
        )
        if claim.claim == ledger.Claim.CONFLICT:
            return failed(409, ApiError.ACTION_REQUEST_CONFLICT)
        if claim.claim == ledger.Claim.REPLAY:
            return self._replayed_report(claim)
        status, result = await self.compute_report(kind, top_n, now)
        stored = json.dumps(result, ensure_ascii=False) if status == 200 else result
        await ledger.finish_action(db, owner, action_request_id, stored, status)
        return ok(result) if status == 200 else reports.report_error(status, result, now)

    async def compute_report(self, kind: str, top_n: int, now: int) -> tuple[int, Any]:
        """(200, report) or (status, ApiError) for one on-demand report (newsletter or owner)."""
        try:
            return 200, await reports.compute(self.env, self, kind, top_n, now, REPORT_ON_DEMAND_BUDGET * 1000)
        except reports.ReportError as exc:
            return exc.status, exc.code
        except Exception as exc:
            _log(report="failed", kind=kind, top_n=top_n, error=type(exc).__name__)
            return 503, ApiError.UNAVAILABLE

    @staticmethod
    def _replayed_report(claim: ledger.ActionClaim) -> Result:
        if claim.http_status is None:
            # Still running, or the run that claimed it was evicted: ask for a new action.
            return failed(503, ApiError.UNAVAILABLE)
        if claim.http_status == 200:
            return ok(json.loads(claim.result_ref or "null"))
        return reports.report_error(claim.http_status, ApiError(claim.result_ref or ApiError.UNAVAILABLE), now_s())

    async def event(self, event_id: str) -> Result:
        if not UUID.fullmatch(event_id):
            return failed(404, ApiError.NOT_FOUND)
        db = self.env.DB
        row = await ledger.get(db, source_id(self.env), event_id)
        if row is None:
            return failed(404, ApiError.NOT_FOUND)
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
            "allowed_actions": list(allowed_actions(row.state, row.last_error_code, canary=row.canary)),
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
        if row.canary:
            # A synthetic end-to-end check (contracts/ops-v1); the lists never show it.
            detail["canary"] = True
        return ok(detail)

    async def budgets(self) -> dict[str, Any]:
        """The next alarm and the Gemini/Todoist budgets, in the Overview's API shape."""
        now = now_s()
        usage = self._usage(now)
        blocked_until = self._control()["todoist_blocked_until"]
        alarm = await self.ctx.storage.getAlarm()
        return {
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

    def report_failures(self, kind: str, top_n: int, day: str) -> int:
        """Failed precompute attempts of one report on ``day`` (YYYY-MM-DD)."""
        rows = self.sql.exec(
            "SELECT count FROM report_failures WHERE kind = ? AND top_n = ? AND day = ?", kind, top_n, day
        ).toArray()
        return int(rows[0].count) if rows else 0

    def count_report_failure(self, kind: str, top_n: int, day: str) -> None:
        self.sql.exec("DELETE FROM report_failures WHERE day < ?", day)
        self.sql.exec(
            "INSERT INTO report_failures (kind, top_n, day, count) VALUES (?, ?, ?, 1)"
            " ON CONFLICT (kind, top_n, day) DO UPDATE SET count = count + 1",
            kind,
            top_n,
            day,
        )

    def record_step(self, point: StepPoint, now: int) -> None:
        """Metrics of one upstream step (Analytics Engine point and the day's counters).

        Best effort and never raises; callers run it after the step's result is committed."""
        metrics.record(self.env, self.sql, point, now)

    def _settle_interrupted_summaries(self) -> None:
        """Count the reservation of a summary call an eviction cut short as spent.

        Google may have processed (and billed) the request, so the tokens stay
        counted, but as used on their own day rather than as a reservation that
        never clears. Runs under the ``running`` guard, so no summary is in flight.
        """
        for row in self.sql.exec("SELECT event_id, day, reserved FROM llm_inflight").toArray():
            self.sql.exec(
                "UPDATE llm_usage SET reserved_tokens = max(reserved_tokens - ?, 0),"
                " used_tokens = used_tokens + ?, calls = calls + 1 WHERE day = ?",
                int(row.reserved),
                int(row.reserved),
                row.day,
            )
            self.sql.exec("DELETE FROM llm_inflight WHERE event_id = ?", row.event_id)

    # The Todoist budget for runtime/gtd.py (read-only snapshot pages and the weekly review).
    def count_todoist_calls(self, calls: int, now: int) -> None:
        self._count_todoist_calls(calls, now)

    def todoist_wait(self, now: int) -> int | None:
        return self._todoist_wait(now)

    def block_todoist(self, now: int) -> int:
        """A 401/403 from Todoist: pause every Todoist call for TODOIST_AUTH_BLOCK; returns its end."""
        until = now + TODOIST_AUTH_BLOCK
        self.sql.exec(SET_CONTROL["todoist_blocked_until"], until)
        return until

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
            if self.woken:
                # A wake-up arrived after _next_alarm_ms looked (e.g. during its D1 read):
                # run again now instead of at the stale next time.
                await self.wake()

    async def _run(self) -> None:
        storage, env = self.ctx.storage, self.env
        if flag(env, "MAINTENANCE_MODE"):
            await storage.setAlarm(now_ms() + DAY * 1000)
            return
        now = now_s()
        await self._arm_watchdog()
        self._settle_interrupted_summaries()
        await ledger.recover_interrupted(env.DB, now, lookup_at=_after(self._lookup_delay()))
        may_start = ops.backup_defer_until(self.sql, now) is None
        if (resume_at := await backup.run(env, self.sql, now, may_start=may_start)) is not None:
            # A backup job holds the ledger and the ticks until it ends (backup.py).
            await storage.setAlarm(resume_at)
            return
        worked = False
        if not flag(env, "PROCESSING_PAUSED"):
            worked = await self._step(now, todoist_open=self._todoist_wait(now) is None)
        await self._ticks()
        await self._gtd_tick()
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
        # The column, or the payload for a row restored from a backup taken without it.
        canary = row.canary or (event is not None and event.canary_run_id is not None)
        # A canary never waits for the owner: where real mail would, it ends ignored (failed).
        stuck = EventState.IGNORED if canary else EventState.FAILED_SUMMARY
        if event is None or event.unreadable:
            # Imported rows may carry a body the current contract rejects; retrying cannot help either.
            code = Code.MAIL_NEEDS_REVIEW if event else Code.INVALID_SAVED_EVENT
            await ledger.transition(db, row, stuck, actor=WORKER, now=now, code=code, next_attempt_at=0)
            return
        content, preface = gemini_wire.summary_content(event), content_notice(event)
        reserved = math.ceil(len((prompts.SUMMARY_EMAIL + preface + content).encode()) / 2) + OUTPUT_TOKEN_ALLOWANCE
        if not self.reserve_tokens(reserved, now):
            tomorrow = now - now % DAY + DAY
            await ledger.transition(
                db,
                row,
                EventState.IGNORED if canary else EventState.PENDING,
                actor=WORKER,
                now=now,
                code=Code.LLM_BUDGET_EXHAUSTED,
                next_attempt_at=0 if canary else tomorrow,
            )
            return
        # Every exit settles the reservation against the day it was taken from: nothing
        # spent before the request goes out, all of it if the call dies midway, the real
        # count after an answer. llm_inflight covers an eviction (_settle_interrupted_summaries).
        used = 0
        self.sql.exec(
            "INSERT OR REPLACE INTO llm_inflight (event_id, day, reserved) VALUES (?, ?, ?)",
            row.event_id,
            _day(now),
            reserved,
        )
        try:
            running = await ledger.transition(db, row, EventState.SUMMARIZING, actor=WORKER, now=now)
            if running is None:
                return
            used, started = reserved, now_ms()
            result = await gemini.generate(
                self.env,
                system=prompts.SUMMARY_EMAIL,
                user=content,
                preface=preface,
                deadline_ms=started + GEMINI_STEP_BUDGET * 1000,
            )
            used = result.tokens
        finally:
            self.sql.exec("DELETE FROM llm_inflight WHERE event_id = ?", row.event_id)
            self.settle_tokens(reserved, used, now)
        # Recorded after the ledger commit, so a metrics failure can never sit between the
        # spent Gemini call and its result (record_step never raises either).
        point = metrics.gemini_point(Step.CANARY if canary else Step.SUMMARY, result, now_ms() - started)
        done = now_s()
        verdict = result.verdict
        if canary:
            await self._finish_canary(running, event, result, done)
        elif verdict.ok:
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
        else:
            code, attempts = verdict.code or Code.SUMMARY_FAILED, running.attempt_count
            if summary_gives_up(attempts, code, done - row.created_at):
                to, next_at = EventState.FAILED_SUMMARY, 0
            else:
                to, next_at = EventState.PENDING, self._retry_at(attempts, verdict.retry_after)
            await ledger.transition(
                db, running, to, actor=WORKER, now=done, code=code, attempt_count=attempts + 1, next_attempt_at=next_at
            )
        self.record_step(point, now)

    async def _finish_canary(self, running: EventRow, event: MailEvent, result: gemini.GeminiResult, done: int) -> None:
        """A canary's summary step ends it: ``complete`` when the answer passes the same checks a
        real summary does (the Todoist request is built, never sent), else retried or ``ignored``."""
        db, verdict = self.env.DB, result.verdict
        if verdict.ok:
            summary = clean_summary(_utf8_prefix(result.text, MAX_SUMMARY_BYTES), event)
            body = render_todo_body(event, summary)
            sender = event.from_addresses[0].address if event.from_addresses else ""
            try:
                build_task_request(
                    task_title(event),
                    body,
                    var(self.env, "TODOIST_DEFAULT_PROJECT_ID"),
                    todoist_request_id(task_title(event), body, sender),
                    var(self.env, "TODOIST_API_KEY"),
                )
            except RequestTooLarge:
                await ledger.transition(
                    db, running, EventState.IGNORED, actor=WORKER, now=done, code=Code.TODOIST_REJECTED
                )
                return
            # No CompletedSummary: a canary never becomes report input.
            await ledger.transition(
                db,
                running,
                EventState.COMPLETE,
                actor=WORKER,
                now=done,
                summary_model=result.model,
                attempt_count=0,
                next_attempt_at=0,
            )
            _log(canary="ok", event_id=running.event_id)
            return
        code, attempts = verdict.code or Code.SUMMARY_FAILED, running.attempt_count
        if code in CANARY_TRANSIENT and attempts + 1 < CANARY_MAX_ATTEMPTS:
            to, next_at = EventState.PENDING, self._retry_at(attempts, verdict.retry_after)
        else:
            to, next_at = EventState.IGNORED, 0
        await ledger.transition(
            db, running, to, actor=WORKER, now=done, code=code, attempt_count=attempts + 1, next_attempt_at=next_at
        )
        _log(canary=to, event_id=running.event_id, code=code)

    async def _block_canary(self, row: EventRow, now: int) -> None:
        """A canary at a step that would call Todoist (only an older release puts it there): end it."""
        await ledger.transition(
            self.env.DB,
            row,
            EventState.IGNORED,
            actor=WORKER,
            now=now,
            code=Code.CANARY_SIDE_EFFECT_BLOCKED,
            next_attempt_at=0,
        )
        _log(canary="blocked", event_id=row.event_id, state=row.state)

    async def _create_task(self, row: EventRow, now: int) -> None:
        db, env = self.env.DB, self.env
        event = self._stored_event(row)
        if row.canary or (event is not None and event.canary_run_id is not None):
            await self._block_canary(row, now)
            return
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
        started = now_ms()
        result = await todoist.create_task(env, request, budget_ms=TODOIST_STEP_BUDGET * 1000)
        point = metrics.task_point(Step.TASK, result, now_ms() - started)
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
        # After the commit: the task already exists, and only the ledger may say so first.
        self.record_step(point, now)

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
        if row.canary or (event is not None and event.canary_run_id is not None):
            # Never report input, whatever an older release did with it.
            await ledger.transition(self.env.DB, row, EventState.COMPLETE, actor=WORKER, now=now, next_attempt_at=0)
            return
        completed = CompletedSummary(event.subject if event else "", row.summary, row.summary_model, row.task_id)
        await ledger.transition(
            self.env.DB, row, EventState.COMPLETE, actor=WORKER, now=now, completed=completed, next_attempt_at=0
        )

    async def _lookup(self, row: EventRow, now: int) -> None:
        """Read-only footer lookup for a todo_unknown row (v2 plan §5.3 step B′)."""
        db = self.env.DB
        if row.canary:
            await self._block_canary(row, now)
            return
        confirmed = await ledger.owner_confirmed_resend(db, row.event_id)
        self._count_todoist_calls(LOOKUP_MAX_PAGES, now)
        started = now_ms()
        found = await todoist.find_footer_tasks(self.env, row.event_id)
        state, code = classify_lookup(None if found is None else len(found))
        point = StepPoint(Step.LOOKUP, state, code=code or "", upstream_ms=now_ms() - started)
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
        self.record_step(point, now)

    async def _ticks(self) -> None:
        """Reminder, report precompute and retention, each when its control time is due."""
        control = self._control()
        for column in TICK_COLUMNS:
            now = now_s()
            if control[column] > now:
                continue
            if column == "next_maintenance" and (held := ops.defer_until(self.sql, ops_rules.Job.RETENTION, now)):
                # Its own time moves, so the alarm does not come back every second while it waits.
                self.sql.exec(SET_CONTROL[column], held)
                continue
            await self._arm_watchdog()
            finished = False
            try:
                next_at = await self._tick(column, now)
                finished = True
            except Exception as exc:
                # One failing tick must not stall the ledger or the other ticks.
                _log(tick=column, error=type(exc).__name__)
                next_at = now + TICK_RETRY
            self.sql.exec(SET_CONTROL[column], next_at)
            # Only a sweep that left no expired rows is retention's run, not one batch of a backlog.
            if column == "next_maintenance" and ops_rules.completed_run(finished, next_at, now, RETENTION_CONTINUE):
                ops.ran(self.sql, ops_rules.Job.RETENTION, now)
        await self._metrics_tick()

    async def _metrics_tick(self) -> None:
        """Write finished days to daily_metrics (its own schedule in metric_flush)."""
        now = now_s()
        if metrics.next_flush(self.sql) > now:
            return
        if held := ops.defer_until(self.sql, ops_rules.Job.METRICS_ROLLUP, now):
            metrics.set_next_flush(self.sql, held)
            return
        await self._arm_watchdog()
        finished = False
        try:
            next_at = await metrics.flush(self.env, self.sql, now)
            finished = True
        except Exception as exc:
            _log(tick="metrics", error=type(exc).__name__)
            next_at = now + TICK_RETRY
        metrics.set_next_flush(self.sql, next_at)
        # A flush that continues in a minute (more transitions or days to write) has not caught up.
        if ops_rules.completed_run(finished, next_at, now, metrics.CONTINUE):
            ops.ran(self.sql, ops_rules.Job.METRICS_ROLLUP, now)

    async def _gtd_tick(self) -> None:
        """The GTD ledger's daily snapshot and weekly review (runtime/gtd.py), when either is due."""
        now = now_s()
        if gtd.next_at(self.sql) > now:
            return
        await self._arm_watchdog()
        try:
            await gtd.tick(self.env, self, now)
        except Exception as exc:
            # Like the other ticks: one failure must not stall the ledger; the job resumes from its state.
            _log(tick="gtd", error=type(exc).__name__)
            gtd.retry_later(self.sql, now, now + TICK_RETRY)

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
        times = [*(control[column] for column in TICK_COLUMNS), metrics.next_flush(self.sql), gtd.next_at(self.sql)]
        if (backup_at := backup.next_run(self.env, self.sql)) is not None:
            # A backup an ops guard holds back is considered again when the guard allows it.
            times.append(max(backup_at, ops.backup_defer_until(self.sql, now) or 0))
        if not flag(self.env, "PROCESSING_PAUSED"):
            wait = self._todoist_wait(now)
            if wait:
                times.append(wait)
            due = await ledger.next_wake_at(self.env.DB, todoist=wait is None)
            if due is not None:
                times.append(due)
        return max(min(times) * 1000, soon)
