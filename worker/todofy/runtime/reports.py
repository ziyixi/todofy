"""Daily summary and recommendation reports for the newsletter (v2 plan §5.3).

Both are precomputed once a day at REPORT_PRECOMPUTE_UTC. A newsletter request
for a report older than 26 hours (or a ``top`` nobody precomputed) asks the
coordinator for one within 40 s, sharing its hourly computation cap; when that
fails the older row is served as ``stale``. Responses validate against
api/summary-v1 and api/recommendation-v1.
"""

import base64
import binascii
import hashlib
import hmac
import json
import math
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

from workers import Response

from todofy.core import prompts
from todofy.core.api_errors import ApiError
from todofy.core.backoff import DAY, HOUR, MINUTE, REPORT_ON_DEMAND_BUDGET
from todofy.core.render import rfc3339
from todofy.core.report_schema import (
    EMPTY_WINDOW_SUMMARY,
    MAX_SUMMARY_CHARS,
    MAX_TOP_N,
    WINDOW_HOURS,
    ReportStatus,
    newsletter_text_ok,
    parse_recommendations,
    parse_top_n,
    recommendation_response_schema,
)
from todofy.core.sql import reports as sql
from todofy.runtime import gemini
from todofy.runtime.config import coordinator as coordinator_stub
from todofy.runtime.config import csv, report_default_top, var
from todofy.runtime.http import error, json_response, with_headers
from todofy.runtime.interop import now_ms

SUMMARY = "summary"
RECOMMENDATION = "recommendation"
DEFAULT_PRECOMPUTE_UTC = "13:30"
FRESH_FOR = 26 * HOUR
RETRY_DELAY = 10 * MINUTE
LOCKOUT_FAILURES = 20
# A day normally has about 100 summaries; the cap bounds D1 reads and model input.
MAX_WINDOW_SUMMARIES = 1000
# The same token estimate as the summary step, plus room for the answer.
OUTPUT_TOKEN_ALLOWANCE = 4096
# The newsletter discards larger responses (newsletter todofy.py _MAX_RESPONSE_BYTES).
MAX_RESPONSE_BYTES = 128 * 1024


class ReportError(Exception):
    """No report could be computed now; the coordinator answers ``error(status, code)``."""

    def __init__(self, status: int, code: ApiError) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def failure_hour(timestamp: int) -> str:
    """The ``auth_failures`` key: the UTC hour as ``YYYY-MM-DDTHH``."""
    return datetime.fromtimestamp(timestamp, UTC).strftime("%Y-%m-%dT%H")


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

    if not summaries:
        model = ""
        if kind == SUMMARY:
            payload = _summary(EMPTY_WINDOW_SUMMARY, 0, ReportStatus.EMPTY_WINDOW, model, stamps)
        else:
            payload = _recommendation([], 0, ReportStatus.EMPTY_WINDOW, model, top_n, stamps)
    else:
        text, model = await _generate(env, coordinator, kind, top_n, summaries, now, budget_ms)
        if kind == SUMMARY:
            if not newsletter_text_ok(text, MAX_SUMMARY_CHARS):
                _log(kind, top_n, "model_output_invalid")
                raise ReportError(503, ApiError.UNAVAILABLE)
            payload = _summary(text, len(summaries), ReportStatus.OK, model, stamps)
        else:
            payload = _parsed_recommendation(text, len(summaries), model, top_n, stamps)

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

    One report per call keeps each alarm to a single Gemini call.
    """
    offset = _precompute_offset(var(env, "REPORT_PRECOMPUTE_UTC", DEFAULT_PRECOMPUTE_UTC))
    if offset is None:
        return now + DAY
    due = now - now % DAY + offset
    if now < due:
        return due
    for kind, top_n in ((SUMMARY, 0), (RECOMMENDATION, report_default_top(env))):
        row = await env.DB.prepare(sql.LATEST_REPORT.sql).bind(kind, top_n).first()
        if row is not None and row.computed_at >= due:
            continue
        try:
            await compute(env, coordinator, kind, top_n, now, REPORT_ON_DEMAND_BUDGET * 1000)
        except ReportError as exc:
            _log(kind, top_n, exc.code)
            return now + RETRY_DELAY
        return now + 1
    return due + DAY


async def serve(request: Any, env: Any, kind: str) -> Response:
    """GET /api/summary and /api/recommendation on the machine hosts (Basic auth)."""
    digests = csv(env, "REPORT_BASIC_AUTH_SHA256")
    if not digests:
        return error(503, ApiError.NOT_CONFIGURED)
    now = now_ms() // 1000
    db = env.DB
    hour = failure_hour(now)
    failures = await db.prepare(sql.AUTH_FAILURES_HOUR.sql).bind(hour).first()
    if failures is not None and failures["count"] >= LOCKOUT_FAILURES:
        return with_headers(error(429, ApiError.RATE_LIMITED), {"retry-after": str(HOUR - now % HOUR)})
    if not _basic_ok(request.headers.get("authorization") or "", digests):
        await db.prepare(sql.COUNT_AUTH_FAILURE.sql).bind(hour).run()
        return with_headers(error(401, ApiError.UNAUTHORIZED), {"www-authenticate": 'Basic realm="todofy"'})

    top_n = 0
    if kind == RECOMMENDATION:
        try:
            top_n = parse_top_n(parse_qs(urlsplit(request.url).query, keep_blank_values=True).get("top", [None])[0])
        except ValueError:
            return error(400, ApiError.INVALID_REQUEST)

    row = await db.prepare(sql.LATEST_REPORT.sql).bind(kind, top_n).first()
    if row is not None and row.computed_at >= now - FRESH_FOR:
        return json_response(json.loads(row.payload_json))
    fresh = await _on_demand(env, kind, top_n)
    if fresh.status == 200 or row is None:
        return fresh
    stale = json.loads(row.payload_json)
    stale["status"] = ReportStatus.STALE
    return json_response(stale)


async def latest(db: Any) -> dict:
    """ReportsLatest: the newest stored summary and the newest recommendation per top_n."""
    keys = [(SUMMARY, 0)] + [(RECOMMENDATION, top_n) for top_n in range(1, MAX_TOP_N + 1)]
    results = await db.batch([db.prepare(sql.LATEST_REPORT.sql).bind(kind, top_n) for kind, top_n in keys])
    stored = [json.loads(result.results[0].payload_json) if result.results else None for result in results]
    return {"summary": stored[0], "recommendations": [report for report in stored[1:] if report is not None]}


async def _generate(
    env: Any, coordinator: Any, kind: str, top_n: int, summaries: list[str], now: int, budget_ms: int
) -> tuple[str, str]:
    """Gemini text and model name; raises ReportError without a usable answer."""
    system = prompts.SUMMARY_RANGE if kind == SUMMARY else prompts.recommend_prompt(top_n)
    user = prompts.report_input(summaries)
    reserved = math.ceil(len((system + user).encode()) / 2) + OUTPUT_TOKEN_ALLOWANCE
    if not coordinator.reserve_tokens(reserved, now):
        _log(kind, top_n, "llm_budget_exhausted")
        raise ReportError(503, ApiError.UNAVAILABLE)
    used = reserved  # if the call dies midway, keep the whole reservation counted
    try:
        result = await gemini.generate(
            env,
            system=system,
            user=user,
            deadline_ms=now_ms() + budget_ms,
            response_schema=None if kind == SUMMARY else recommendation_response_schema(top_n),
        )
        used = result.tokens
    finally:
        coordinator.settle_tokens(reserved, used, now)
    if not result.verdict.ok:
        _log(kind, top_n, result.verdict.code or "")
        raise ReportError(503, ApiError.UNAVAILABLE)
    return result.text, result.model


def _parsed_recommendation(text: str, count: int, model: str, top_n: int, stamps: dict[str, str]) -> dict:
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
    tasks: list[dict], count: int, status: ReportStatus, model: str, top_n: int, stamps: dict[str, str]
) -> dict:
    return {"tasks": tasks, "model": model, "task_count": count, "status": status, "top_n": top_n, **stamps}


async def _on_demand(env: Any, kind: str, top_n: int) -> Response:
    """The coordinator's answer: 200 with the new report, or an error envelope."""
    try:
        return await coordinator_stub(env).fetch(
            "https://coordinator/report",
            method="POST",
            headers={"content-type": "application/json"},
            body=json.dumps({"kind": kind, "top_n": top_n, "budget_ms": REPORT_ON_DEMAND_BUDGET * 1000}),
        )
    except Exception:  # any coordinator failure must still let the stale row be served
        return error(503, ApiError.UNAVAILABLE)


def _basic_ok(header: str, digests: list[str]) -> bool:
    scheme, _, encoded = header.partition(" ")
    if scheme.lower() != "basic":
        return False
    try:
        credentials = base64.b64decode(encoded.strip(), validate=True)
    except (binascii.Error, ValueError):
        return False
    presented = hashlib.sha256(credentials).hexdigest()
    # Compare against every digest so timing does not reveal which one matched.
    matches = [hmac.compare_digest(presented, digest) for digest in digests]
    return any(matches)


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
