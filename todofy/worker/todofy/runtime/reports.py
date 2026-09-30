"""Daily summary and recommendation reports for the newsletter (v2 plan §5.3).

Both are precomputed once a day at REPORT_PRECOMPUTE_UTC. The newsletter gets a
stored row only when it was computed since the latest precompute time and is
usable (``ok`` or ``empty_window``); otherwise the coordinator computes one
within 40 s, under its hourly computation cap, and answers 503 when that
fails. The recommendation's input is the 24 h window plus the carryover: older
mail tasks the day's Todoist snapshot still lists as open (docs/gtd-features.md
§3); without a usable snapshot it is exactly the 24 h report. The newsletter
reads only the HTTP status, so an old or unusable report is never sent as a 200.
Responses validate against api/summary-v1 and api/recommendation-v1.
"""

import json
import math
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs

from todofy.core import gtd, prompts
from todofy.core.api_errors import ApiError
from todofy.core.backoff import DAY, HOUR, MINUTE, REPORT_ON_DEMAND_BUDGET
from todofy.core.metrics import Step
from todofy.core.render import rfc3339
from todofy.core.report_schema import (
    EMPTY_WINDOW_SUMMARY,
    MAX_TOP_N,
    WINDOW_HOURS,
    ReportStatus,
    fit_summary,
    parse_recommendations,
    parse_top_n,
    recommendation_response_schema,
)
from todofy.core.sql import reports as sql
from todofy.runtime import gemini, metrics
from todofy.runtime.config import flag, integer, report_default_top, var
from todofy.runtime.http import Result, failed, ok
from todofy.runtime.interop import now_ms

SUMMARY = "summary"
RECOMMENDATION = "recommendation"
DEFAULT_PRECOMPUTE_UTC = "13:30"
RETRY_DELAY = 10 * MINUTE
# Automatic precompute attempts per report and UTC day; after that only the newsletter
# (on demand, under the hourly cap) or the owner's recompute tries again.
PRECOMPUTE_ATTEMPTS = 3
# Stored statuses the newsletter may be given.
SERVABLE = frozenset({ReportStatus.OK, ReportStatus.EMPTY_WINDOW})
LOCKOUT_FAILURES = 20
# A day normally has about 100 summaries; the cap bounds D1 reads and model input.
MAX_WINDOW_SUMMARIES = 1000
# The same token estimate as the summary step, plus room for the answer.
OUTPUT_TOKEN_ALLOWANCE = 4096
# The newsletter discards larger responses (newsletter todofy.py _MAX_RESPONSE_BYTES).
MAX_RESPONSE_BYTES = 128 * 1024


class ReportError(Exception):
    """No report could be computed now; the coordinator answers ``failed(status, code)``."""

    def __init__(self, status: int, code: ApiError) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def failure_hour(timestamp: int) -> str:
    """The ``auth_failures`` key: the UTC hour as ``YYYY-MM-DDTHH``."""
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%dT%H")


def report_error(status: int, code: ApiError, now: int) -> Result:
    """A report that could not be computed; a 429 says when the hourly cap resets."""
    return failed(status, code, HOUR - now % HOUR if status == 429 else None)


async def compute(env: Any, coordinator: Any, kind: str, top_n: int, now: int, budget_ms: int) -> dict:
    """Compute, store and return one report. Runs in the coordinator.

    ``top_n`` is 0 for the summary; ``budget_ms`` bounds the Gemini call.
    Raises ReportError when over the hourly cap or when no usable answer came back.
    """
    if kind == SUMMARY:
        top_n = 0
    if not coordinator.take_report_slot(now):
        raise ReportError(429, ApiError.RATE_LIMITED)
    start = now - WINDOW_HOURS * HOUR
    window = await env.DB.prepare(sql.REPORT_WINDOW.sql).bind(start, now, MAX_WINDOW_SUMMARIES).all()
    summaries = [row.summary for row in window.results]
    stamps = {"computed_at": _stamp(now), "window_start": _stamp(start), "window_end": _stamp(now)}
    # The recommendation also sees older mail tasks still open in Todoist (never the summary report).
    carried = await carryover(env, start, now) if kind == RECOMMENDATION else []
    counts = {"new_count": len(summaries), "carryover_count": len(carried)}
    summaries += carried

    if not summaries:
        model = ""
        if kind == SUMMARY:
            payload = _summary(EMPTY_WINDOW_SUMMARY, 0, ReportStatus.EMPTY_WINDOW, model, stamps)
        else:
            payload = _recommendation([], 0, ReportStatus.EMPTY_WINDOW, model, top_n, stamps | counts)
    else:
        text, model = await _generate(env, coordinator, kind, top_n, summaries, now, budget_ms, bool(carried))
        if kind == SUMMARY:
            # A long day is cut to fit rather than failed: the same prompt would fail again.
            fitted = fit_summary(text)
            if fitted is None:
                _log(kind, top_n, "model_output_invalid")
                raise ReportError(503, ApiError.UNAVAILABLE)
            if fitted != text:
                _log(kind, top_n, "summary_fitted")
            payload = _summary(fitted, len(summaries), ReportStatus.OK, model, stamps)
        else:
            payload = _parsed_recommendation(text, len(summaries), model, top_n, stamps | counts)

    await (
        env.DB.prepare(sql.STORE_REPORT.sql)
        .bind(
            kind,
            top_n,
            _stamp(now)[:10],
            payload["status"],
            json.dumps(payload, ensure_ascii=False),
            model,
            len(summaries),
            start,
            now,
            now,
        )
        .run()
    )
    return payload


async def tick(env: Any, coordinator: Any, now: int) -> int:
    """Precompute today's reports once REPORT_PRECOMPUTE_UTC has passed; returns the next check time.

    One report per call keeps each alarm to a single Gemini call. A report that
    failed (or came back unusable) is retried in RETRY_DELAY, after the other one,
    and at most PRECOMPUTE_ATTEMPTS times a day, so one bad day cannot spend
    Gemini calls until midnight or keep the other report from being computed.
    """
    offset = _precompute_offset(var(env, "REPORT_PRECOMPUTE_UTC", DEFAULT_PRECOMPUTE_UTC))
    if offset is None:
        return now + DAY
    due = now - now % DAY + offset
    if now < due:
        return due
    day = _stamp(now)[:10]
    todo: list[tuple[int, str, int]] = []
    for kind, top_n in ((SUMMARY, 0), (RECOMMENDATION, report_default_top(env))):
        row = await env.DB.prepare(sql.LATEST_REPORT.sql).bind(kind, top_n).first()
        if row is not None and row.computed_at >= due and row.status in SERVABLE:
            continue
        failures = coordinator.report_failures(kind, top_n, day)
        if failures < PRECOMPUTE_ATTEMPTS:
            todo.append((failures, kind, top_n))
    if not todo:
        return due + DAY
    _, kind, top_n = min(todo, key=lambda item: item[0])  # stable: the summary first on a tie
    try:
        payload = await compute(env, coordinator, kind, top_n, now, REPORT_ON_DEMAND_BUDGET * 1000)
    except ReportError as exc:
        _log(kind, top_n, exc.code)
        coordinator.count_report_failure(kind, top_n, day)
        return now + RETRY_DELAY
    if payload["status"] not in SERVABLE:
        coordinator.count_report_failure(kind, top_n, day)
        return now + RETRY_DELAY
    return now + 1


def last_precompute(env: Any, now: int) -> int:
    """The latest precompute time at or before ``now`` (24 hours ago when precompute is off).

    A stored report is fresh for the newsletter only when computed at or after it.
    """
    offset = _precompute_offset(var(env, "REPORT_PRECOMPUTE_UTC", DEFAULT_PRECOMPUTE_UTC))
    if offset is None:
        return now - DAY
    due = now - now % DAY + offset
    return due if now >= due else due - DAY


async def serve(env: Any, coordinator: Any, kind: str, query: str) -> Result:
    """GET /api/summary and /api/recommendation after the gateway accepted the Basic credential."""
    top_n = 0
    if kind == RECOMMENDATION:
        try:
            top_n = parse_top_n(parse_qs(query, keep_blank_values=True).get("top", [None])[0])
        except ValueError:
            return failed(400, ApiError.INVALID_REQUEST)

    now = now_ms() // 1000
    row = await env.DB.prepare(sql.LATEST_REPORT.sql).bind(kind, top_n).first()
    if row is not None and row.computed_at >= last_precompute(env, now) and row.status in SERVABLE:
        return ok(json.loads(row.payload_json))
    if flag(env, "MAINTENANCE_MODE"):
        return failed(503, ApiError.MAINTENANCE)
    status, result = await coordinator.compute_report(kind, top_n, now)
    if status != 200:
        return report_error(status, result, now)
    if result["status"] not in SERVABLE:
        # model_output_invalid: an empty list would read as "nothing important today".
        return failed(503, ApiError.UNAVAILABLE)
    return ok(result)


async def count_auth_failure(db: Any, now: int) -> Result:
    """A newsletter request whose Basic credential the gateway rejected.

    A correct credential never comes here, so no number of failures can block it
    (a lockout that did would let anyone deny the newsletter its report). The
    counter only throttles failures and stops writing once locked, so it costs at
    most LOCKOUT_FAILURES D1 writes an hour.
    """
    hour = failure_hour(now)
    failures = await db.prepare(sql.AUTH_FAILURES_HOUR.sql).bind(hour).first()
    if failures is not None and failures["count"] >= LOCKOUT_FAILURES:
        return report_error(429, ApiError.RATE_LIMITED, now)
    await db.prepare(sql.COUNT_AUTH_FAILURE.sql).bind(hour).run()
    # The gateway adds the Basic challenge (WWW-Authenticate) to this 401.
    return failed(401, ApiError.UNAUTHORIZED)


async def latest(db: Any) -> dict:
    """ReportsLatest: the newest stored summary and the newest recommendation per top_n."""
    keys = [(SUMMARY, 0)] + [(RECOMMENDATION, top_n) for top_n in range(1, MAX_TOP_N + 1)]
    results = await db.batch([db.prepare(sql.LATEST_REPORT.sql).bind(kind, top_n) for kind, top_n in keys])
    stored = [json.loads(result.results[0].payload_json) if result.results else None for result in results]
    return {"summary": stored[0], "recommendations": [report for report in stored[1:] if report is not None]}


async def carryover(env: Any, window_start: int, now: int) -> list[str]:
    """Mail tasks from the REPORT_CARRYOVER_DAYS before the 24 h window that today's Todoist snapshot
    still lists as open, newest first, at most CARRYOVER_MAX_ROWS, each as ``[N 天前] summary``.

    Empty (and the recommendation exactly the 24 h report) without an ``ok`` snapshot finished in
    the last 26 hours (runtime/gtd.py takes it at 13:00 UTC), with REPORT_CARRYOVER_DAYS = 0, or when
    anything here fails: the carryover never costs the morning brief.
    """
    days = min(integer(env, "REPORT_CARRYOVER_DAYS", gtd.DEFAULT_CARRYOVER_DAYS), gtd.MAX_CARRYOVER_DAYS)
    if days == 0:
        return []
    db = env.DB
    try:
        fresh = now - gtd.SNAPSHOT_FRESH
        snapshot = await db.prepare(sql.LATEST_OK_SNAPSHOT.sql).bind(gtd.day_of(fresh), gtd.day_of(now), fresh).first()
        if snapshot is None:
            print(json.dumps({"report": RECOMMENDATION, "carryover": "no_snapshot"}))
            return []
        rows = await (
            db.prepare(sql.CARRYOVER.sql)
            .bind(now - days * DAY, window_start, snapshot["day"], gtd.CARRYOVER_MAX_ROWS)
            .all()
        )
        carried = [gtd.carried_line(row["summary"], now, int(row["created_at"])) for row in rows.results]
    except Exception as exc:
        print(json.dumps({"report": RECOMMENDATION, "carryover": "failed", "error": type(exc).__name__}))
        return []
    print(json.dumps({"report": RECOMMENDATION, "carryover": len(carried)}))
    return carried


async def _generate(
    env: Any,
    coordinator: Any,
    kind: str,
    top_n: int,
    summaries: list[str],
    now: int,
    budget_ms: int,
    carryover: bool = False,
) -> tuple[str, str]:
    """Gemini text and model name; raises ReportError without a usable answer."""
    system = prompts.SUMMARY_RANGE if kind == SUMMARY else prompts.recommend_prompt(top_n, carryover)
    user = prompts.report_input(summaries)
    reserved = math.ceil(len((system + user).encode()) / 2) + OUTPUT_TOKEN_ALLOWANCE
    if not coordinator.reserve_tokens(reserved, now):
        _log(kind, top_n, "llm_budget_exhausted")
        raise ReportError(503, ApiError.UNAVAILABLE)
    used = reserved  # if the call dies midway, keep the whole reservation counted
    started = now_ms()
    try:
        result = await gemini.generate(
            env,
            system=system,
            user=user,
            deadline_ms=started + budget_ms,
            response_schema=None if kind == SUMMARY else recommendation_response_schema(top_n),
        )
        used = result.tokens
    finally:
        coordinator.settle_tokens(reserved, used, now)
    coordinator.record_step(metrics.gemini_point(Step.REPORT, result, now_ms() - started), now)
    if not result.verdict.ok:
        _log(kind, top_n, result.verdict.code or "")
        raise ReportError(503, ApiError.UNAVAILABLE)
    return result.text, result.model


def _parsed_recommendation(text: str, count: int, model: str, top_n: int, stamps: dict[str, Any]) -> dict:
    recommendations = parse_recommendations(text, top_n)
    if recommendations is not None:
        tasks = [{"rank": r.rank, "title": r.title, "reason": r.reason} for r in recommendations]
        payload = _recommendation(tasks, count, ReportStatus.OK, model, top_n, stamps)
        if len(json.dumps(payload, ensure_ascii=False).encode()) <= MAX_RESPONSE_BYTES:
            return payload
    _log(RECOMMENDATION, top_n, "model_output_invalid")
    return _recommendation([], count, ReportStatus.MODEL_OUTPUT_INVALID, model, top_n, stamps)


def _summary(text: str, count: int, status: ReportStatus, model: str, stamps: dict[str, str]) -> dict:
    return {
        "summary": text,
        "task_count": count,
        "time_window_hours": WINDOW_HOURS,
        "status": status,
        "model": model,
        **stamps,
    }


def _recommendation(
    tasks: list[dict], count: int, status: ReportStatus, model: str, top_n: int, fields: dict[str, Any]
) -> dict:
    """``fields``: the timestamps plus new_count and carryover_count (task_count is their sum)."""
    return {"tasks": tasks, "model": model, "task_count": count, "status": status, "top_n": top_n, **fields}


def _precompute_offset(value: str) -> int | None:
    """Seconds after UTC midnight for ``HH:MM``; None for ``off`` (test configs only)."""
    if value == "off":
        return None
    hours, _, minutes = value.partition(":")
    if not (hours.isdigit() and minutes.isdigit() and int(hours) < 24 and int(minutes) < 60):
        return _precompute_offset(DEFAULT_PRECOMPUTE_UTC)
    return int(hours) * HOUR + int(minutes) * MINUTE


def _stamp(timestamp: int) -> str:
    return rfc3339(datetime.fromtimestamp(timestamp, UTC))


def _log(kind: str, top_n: int, code: str) -> None:
    print(json.dumps({"report": kind, "top_n": top_n, "code": code}))
