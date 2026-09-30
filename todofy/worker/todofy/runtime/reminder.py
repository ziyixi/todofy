"""The owner's daily attention reminder: at most one Todoist task per UTC day (v2 plan §5.3).

The day is claimed in D1 before Todoist is called and its title and body are
frozen, so a retry sends the same bytes and X-Request-Id
(mail_inbox_worker.go:559-666 @ 6c46ed4). Only a failure that cannot have
created a task (``failed``) is retried, hourly and at most REMINDER_MAX_ATTEMPTS
times; ``unknown`` is never resent that day.

The day's task also carries the ops digest (contracts/ops-v1): the warning and
critical items of the dashboard's latest report, while it is at most 36 hours old
and no earlier day's reminder listed it. A day with ops items but nothing needing
attention still gets its one task, from a report generated before that UTC day
began (the dashboard reports at about 23:40 for the next day). The text is frozen
with the claim like the rest, so a report that arrives later never causes a
second task that day. Canary events are never counted or listed.
"""

import json
from datetime import UTC, datetime
from typing import Any

from todofy.core.backoff import (
    DAY,
    REMINDER_CHECK_INTERVAL,
    REMINDER_MAX_ATTEMPTS,
    REMINDER_RETRY_DELAY,
    TODOIST_STEP_BUDGET,
)
from todofy.core.classify import TaskResult, TaskVerdict
from todofy.core.metrics import Step
from todofy.core.ops import Report, digest
from todofy.core.reminder_text import LIST_LIMIT, SENDER, AttentionRow, reminder_body, reminder_title
from todofy.core.render import rfc3339
from todofy.core.request_id import todoist_request_id
from todofy.core.sql import reminders as sql
from todofy.core.todoist_request import TaskRequest, build_task_request
from todofy.core.vocab import ATTENTION_AGE_SECONDS, Code, ReminderState
from todofy.runtime import metrics, todoist
from todofy.runtime.config import flag, source_id, var
from todofy.runtime.interop import now_ms

# Sorts after every YYYY-MM-DD, so the first page starts at the newest day.
_AFTER_EVERY_DAY = "9999-99-99"


async def tick(env: Any, coordinator: Any, now: int) -> int:
    """Send today's reminder if it is due; returns the next check time.

    Call it only from the alarm loop: a day still ``sending`` here is taken to
    be an interrupted call from an earlier run.
    """
    db = env.DB
    await db.prepare(sql.RECOVER_SENDING.sql).bind(Code.INTERRUPTED_REMINDER_CALL, now).run()
    # PROCESSING_PAUSED parks the whole Todoist side, including this reminder (a parked
    # stack after a rollback must not post its own daily task).
    if not flag(env, "REMINDER_ENABLED") or flag(env, "FORCE_PAUSE_TODOIST") or flag(env, "PROCESSING_PAUSED"):
        return now + REMINDER_CHECK_INTERVAL
    day = _day(now)
    tomorrow = now - now % DAY + DAY
    row = await db.prepare(sql.REMINDER_DAY.sql).bind(day).first()
    if row is not None:
        if row.state != ReminderState.FAILED or row.attempts >= REMINDER_MAX_ATTEMPTS:
            return tomorrow
        if row.next_attempt_at > now:
            return row.next_attempt_at

    source, cutoff = source_id(env), now - ATTENTION_AGE_SECONDS
    attention = (await db.prepare(sql.ATTENTION_COUNT.sql).bind(source, cutoff).first()).n
    if row is None:
        report = coordinator.latest_ops_report()
        ops = digest(report, now)
        if ops is not None and not await _ops_due(db, report, day, now, attention > 0):
            ops = None
        if attention == 0 and ops is None:
            return now + REMINDER_CHECK_INTERVAL
        attempts, rows = 0, []
        if attention > 0:
            listed = await db.prepare(sql.ATTENTION_ROWS.sql).bind(source, cutoff, LIST_LIMIT).all()
            rows = [AttentionRow(r.event_id, r.state, r.last_error_code, r.created_at) for r in listed.results]
        ops_count, ops_generated = (0, 0) if ops is None else (len(ops.items), report.generated_ms)
        subject = reminder_title(attention, ops_count)
        body = reminder_body(attention, day, rows, var(env, "TODOFY_PUBLIC_HOST"), ops)
        claim = (
            await db.prepare(sql.CLAIM_DAY.sql)
            .bind(day, subject, body, attention, ops_count, ops_generated, now, now)
            .run()
        )
    else:
        # A failed day is retried with its frozen text while it still has something to say: mail that
        # needs attention, or the ops items it was claimed for (the digest was due then).
        if attention == 0 and row.ops_count == 0:
            return now + REMINDER_CHECK_INTERVAL
        attempts, subject, body = row.attempts, row.subject, row.body
        claim = await db.prepare(sql.CLAIM_RETRY.sql).bind(now, day, attempts, now).run()
    if claim.meta.changes != 1:
        return now + REMINDER_CHECK_INTERVAL

    started = now_ms()
    result = await todoist.create_task(env, _request(env, subject, body), budget_ms=TODOIST_STEP_BUDGET * 1000)
    point = metrics.task_point(Step.REMINDER, result, now_ms() - started)
    state, code = _outcome(result.verdict)
    retry_at = now + REMINDER_RETRY_DELAY
    retries_left = state == ReminderState.FAILED and attempts + 1 < REMINDER_MAX_ATTEMPTS
    await db.prepare(sql.FINISH.sql).bind(state, result.task_id, retry_at if retries_left else 0, code, now, day).run()
    coordinator.record_step(point, now)  # after FINISH: the created task is recorded first
    print(json.dumps({"reminder_day": day, "attempt": attempts + 1, "state": state, "error_code": code}))
    return retry_at if retries_left else tomorrow


async def page(db: Any, before_day: str | None, limit: int) -> tuple[list[dict], str | None]:
    """Reminders newest day first, strictly before ``before_day``; the next cursor is the
    last listed day (the caller encodes it), or None on the last page."""
    rows = await db.prepare(sql.REMINDER_PAGE.sql).bind(before_day or _AFTER_EVERY_DAY, limit + 1).all()
    items = [_item(row) for row in rows.results[:limit]]
    return items, items[-1]["day"] if len(rows.results) > limit else None


async def _ops_due(db: Any, report: Report, day: str, now: int, attention: bool) -> bool:
    """Whether today's new reminder lists ``report``'s digest.

    Each report is listed by at most one day's reminder. On its own (nothing needs attention) a
    report waits for the first UTC day after the one it was generated on: the dashboard reports at
    about 23:40 for the next day's reminder, and sending at once would make that day's task and the
    next day's, 20 minutes apart, list the same items.
    """
    if not attention and report.generated_ms >= (now - now % DAY) * 1000:
        return False
    first = _day(report.generated_ms // 1000)
    carried = await db.prepare(sql.OPS_CARRIED.sql).bind(first, day, report.generated_ms).first()
    return carried.n == 0


def _request(env: Any, subject: str, body: str) -> TaskRequest:
    return build_task_request(
        subject,
        body,
        var(env, "TODOIST_DEFAULT_PROJECT_ID"),
        todoist_request_id(subject, body, SENDER),
        var(env, "TODOIST_API_KEY"),
    )


def _outcome(verdict: TaskVerdict) -> tuple[ReminderState, str]:
    """The reminder view of a create-task verdict (same rule as classify.classify_reminder)."""
    match verdict.result:
        case TaskResult.CREATED:
            return ReminderState.CREATED, ""
        case TaskResult.UNKNOWN:
            return ReminderState.UNKNOWN, Code.REMINDER_RESULT_UNKNOWN
    return ReminderState.FAILED, Code.REMINDER_CREATE_FAILED


def _item(row: Any) -> dict:
    """One OpenAPI ``Reminder``: IDs, states and codes only, never the frozen text."""
    return {
        "day": row.day,
        "state": row.state,
        "task_id": row.task_id or None,
        "attention_count": row.attention_count,
        "attempts": row.attempts,
        "error_code": row.last_error_code or None,
        "next_attempt_at": _stamp(row.next_attempt_at) if row.next_attempt_at else None,
        "created_at": _stamp(row.created_at),
        "updated_at": _stamp(row.updated_at),
        "imported": bool(row.imported),
    }


def _day(timestamp: int) -> str:
    return _stamp(timestamp)[:10]


def _stamp(timestamp: int) -> str:
    return rfc3339(datetime.fromtimestamp(timestamp, UTC))
