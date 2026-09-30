"""The GTD ledger inside TodofyCore (docs/gtd-features.md; core/gtd.py has the rules).

Two jobs run from the coordinator's alarm loop, each on its own time in the object's storage:

- ``collect``: once a UTC day at GTD_COLLECT_UTC (13:00), a read-only snapshot of the active Todoist
  tasks (``GET /api/v1/tasks``, at most 10 pages of 200), the 7-day completed list
  (``GET /api/v1/tasks/completed/by_completion_date``, at most 5 pages) and the day's aggregates. At
  most CALLS_PER_ALARM Todoist GETs per invocation; a longer run continues a second later from the
  cursor kept here. A failed attempt is retried in 10 minutes, at most three times a day.
- ``review``: on Sunday from 17:00 UTC, one Todoist task per ISO week that holds counts, trends and
  links only. Claimed in D1 before the POST with its text and project frozen, exactly like the daily
  reminder: ``unknown`` is never resent, ``failed`` is retried hourly up to five times that week.

Task text never outlives a page: core.gtd keeps a metadata whitelist and a keyed hash (the key is
generated here and never leaves the object's storage). Logs carry states, codes and counts only.
The object's state is lossable like the other object tables: everything is then due now, the HMAC
key is new (hashes change once) and the ops counters are absent until the next collection.
"""

import json
import secrets
from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import urlencode

from todofy.core import gtd as rules
from todofy.core import ops as ops_rules
from todofy.core.backoff import DAY, REMINDER_CHECK_INTERVAL, TODOIST_MAX_ATTEMPTS, TODOIST_STEP_BUDGET
from todofy.core.classify import TaskResult, TaskVerdict
from todofy.core.gtd import GtdCode, Scope, SnapshotStatus
from todofy.core.metrics import Step, StepPoint
from todofy.core.request_id import todoist_request_id
from todofy.core.sql import gtd as sql
from todofy.core.sql import reminders as reminder_sql
from todofy.core.todoist_request import TASKS_PATH, build_task_request, parse_task_page
from todofy.core.vocab import ATTENTION_AGE_SECONDS, ReminderState
from todofy.runtime import metrics, ops, todoist
from todofy.runtime.config import flag, integer, source_id, var
from todofy.runtime.interop import fetch_with_timeout, now_ms

DO_SCHEMA = ("CREATE TABLE IF NOT EXISTS gtd_state (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL)",)
COMPLETED_PATH = "/api/v1/tasks/completed/by_completion_date"
PAGE_TIMEOUT_MS = 20_000
CONTINUE = 1
IDLE, TASKS, COMPLETED, AGGREGATE = "idle", "tasks", "completed", "aggregate"
# Created reviews this many weeks back are watched for their completion.
WATCHED_WEEKS = 3
HISTORY_WEEKS = 12


@dataclass
class State:
    """The object's GTD state (one JSON document in ``gtd_state``)."""

    next_collect: int = 0
    next_review: int = 0
    # The running (or last) collection.
    day: str = ""
    phase: str = IDLE
    cursor: str = ""
    pages: int = 0
    completed_pages: int = 0
    skipped: int = 0
    partial: bool = False
    started: int = 0
    attempts: int = 0
    held: bool = False  # the next attempt waits for a shed guard (ops-v1)
    tally: str | None = None  # core.gtd.CompletedTally JSON; None once the completed list failed
    watched: list[list[str]] = field(default_factory=list)  # [week, task_id] of reviews not yet seen done
    # What ops status() reads.
    first_attempt_at: int | None = None
    last_ok_at: int | None = None
    counters: dict[str, int] = field(default_factory=dict)
    last_review_at: int | None = None
    first_review_at: int | None = None
    hmac_key: str = ""


def load(store: Any) -> State:
    rows = store.exec("SELECT doc FROM gtd_state WHERE id = 1").toArray()
    if not rows:
        return State()
    try:
        doc = json.loads(str(rows[0].doc))
        return State(**{name: doc[name] for name in State.__dataclass_fields__ if name in doc})
    except (ValueError, TypeError):
        return State()


def save(store: Any, state: State) -> None:
    store.exec(
        "INSERT INTO gtd_state (id, doc) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc",
        json.dumps(asdict(state), separators=(",", ":")),
    )


def next_at(store: Any) -> int:
    state = load(store)
    return min(state.next_collect, state.next_review)


def retry_later(store: Any, now: int, at: int) -> None:
    """After a failed tick: every time that was due moves to ``at`` (the job resumes from its state)."""
    state = load(store)
    if state.next_collect <= now:
        state.next_collect = at
    if state.next_review <= now:
        state.next_review = at
    save(store, state)


def release(store: Any, now: int) -> None:
    """A shed guard ended or changed: a snapshot it held back is due again (run, or held anew)."""
    state = load(store)
    if state.held:
        state.held, state.next_collect = False, min(state.next_collect, now)
        save(store, state)


def _log(**fields: Any) -> None:
    # States, codes and counts only: never task text or Todoist bodies.
    print(json.dumps({"gtd": fields}))


def _collect_offset(env: Any) -> int | None:
    return rules.utc_offset(var(env, "GTD_COLLECT_UTC", rules.DEFAULT_COLLECT_UTC))


def _todoist_paused(env: Any) -> bool:
    return flag(env, "PROCESSING_PAUSED") or flag(env, "FORCE_PAUSE_TODOIST")


def facts(env: Any, store: Any) -> rules.GtdFacts:
    """What ops status() needs, from the object's storage only."""
    state = load(store)
    return rules.GtdFacts(
        collect_enabled=_collect_offset(env) is not None and not _todoist_paused(env),
        review_enabled=flag(env, "GTD_REVIEW_ENABLED"),
        last_ok_at=state.last_ok_at,
        first_attempt_at=state.first_attempt_at,
        counters=dict(state.counters),
        last_review_at=state.last_review_at,
        first_review_at=state.first_review_at,
    )


async def tick(env: Any, coordinator: Any, now: int) -> None:
    """Run whichever of the two jobs is due; each moves its own time."""
    store = coordinator.sql
    state = load(store)
    if state.next_collect <= now:
        state = await _collect(env, coordinator, state, now)
        save(store, state)
    if state.next_review <= now:
        state.next_review = await _review(env, coordinator, state, now)
        save(store, state)


# ---- collect -------------------------------------------------------------------------------


def _key(state: State) -> bytes:
    if len(state.hmac_key) != 64:
        state.hmac_key = secrets.token_hex(32)
    return bytes.fromhex(state.hmac_key)


def _base(env: Any) -> str:
    return var(env, "TODOIST_API_BASE", todoist.DEFAULT_API_BASE).rstrip("/")


async def _get(env: Any, coordinator: Any, path: str, query: dict[str, Any], now: int) -> Any:
    coordinator.count_todoist_calls(1, now)
    return await fetch_with_timeout(
        f"{_base(env)}{path}?{urlencode(query)}",
        # Test configs shorten it (like the other *_MS knobs); production uses the constant.
        timeout_ms=integer(env, "GTD_PAGE_TIMEOUT_MS", PAGE_TIMEOUT_MS),
        method="GET",
        headers={"Authorization": f"Bearer {var(env, 'TODOIST_API_KEY')}"},
    )


def _point(code: str, started_ms: int) -> StepPoint:
    """One Analytics Engine point per snapshot page: outcome, code and latency only."""
    return StepPoint(Step.GTD, "failed" if code else "ok", code=code, upstream_ms=now_ms() - started_ms)


def _failure(status: int | None) -> GtdCode:
    if status in (401, 403):
        return GtdCode.TODOIST_AUTH_BLOCKED
    if status == 429:
        return GtdCode.TODOIST_RATE_LIMITED
    return GtdCode.TODOIST_UNAVAILABLE


async def _collect(env: Any, coordinator: Any, state: State, now: int) -> State:
    offset = _collect_offset(env)
    if offset is None:
        state.next_collect = now + DAY
        return state
    today = rules.day_of(now)
    if state.phase != IDLE and state.day != today:
        # A collection that did not finish on its own day is given up; today's starts fresh.
        await _finish_failed(env, state, GtdCode.INTERRUPTED, now, rules.next_collect(now, offset))
    if state.phase == IDLE:
        if _todoist_paused(env):
            state.next_collect = now + rules.COLLECT_RETRY
            return state
        attempts = state.attempts if state.day == today else 0
        if attempts >= rules.COLLECT_ATTEMPTS:
            state.next_collect = rules.next_collect(now, offset)
            return state
        if (held := ops.defer_until(coordinator.sql, ops_rules.Job.GTD_SNAPSHOT, now)) is not None:
            state.next_collect, state.held = held, True
            return state
        state.held = False
        if (wait := coordinator.todoist_wait(now)) is not None:
            state.next_collect = wait or now + rules.COLLECT_RETRY
            return state
        db = env.DB
        await db.batch(
            [
                db.prepare(sql.SNAPSHOT_START.sql).bind(today, now),
                db.prepare(sql.CLEAR_DAY.sql).bind(today, rules.MAX_SNAPSHOT_ROWS),
            ]
        )
        state.day, state.phase, state.cursor = today, TASKS, ""
        state.pages = state.completed_pages = state.skipped = 0
        state.partial, state.started, state.attempts = False, now, attempts + 1
        state.tally, state.watched = rules.CompletedTally().dumps(), []
        if state.first_attempt_at is None:
            state.first_attempt_at = now
        _log(collect="start", day=today, attempt=state.attempts)
    calls = 0
    while state.phase != IDLE:
        if state.phase in (TASKS, COMPLETED):
            if calls >= rules.CALLS_PER_ALARM:
                state.next_collect = now + CONTINUE
                return state
            wait = coordinator.todoist_wait(now)
            if wait is not None or _todoist_paused(env):
                # Paused or blocked mid-way: pick up from the cursor later the same day.
                state.next_collect = wait or now + rules.COLLECT_RETRY
                return state
            calls += 1
        if state.phase == TASKS:
            await _task_page(env, coordinator, state, now, offset)
        elif state.phase == COMPLETED:
            await _completed_page(env, coordinator, state, now)
        else:
            await _aggregate(env, coordinator, state, now, offset)
    return state


async def _task_page(env: Any, coordinator: Any, state: State, now: int, offset: int) -> None:
    query: dict[str, Any] = {"limit": rules.PAGE_SIZE}
    if state.cursor:
        query["cursor"] = state.cursor
    started = now_ms()
    upstream = await _get(env, coordinator, TASKS_PATH, query, now)
    outcome = upstream.outcome()
    code = ""
    if not outcome.ok:
        code = _failure(outcome.status)
    else:
        try:
            tasks, cursor = parse_task_page(upstream.body)
        except ValueError:
            code = GtdCode.MALFORMED_PAGE
    coordinator.record_step(_point(code, started), now)
    if code:
        retry = now + max(rules.COLLECT_RETRY, int(outcome.retry_after))
        if code == GtdCode.TODOIST_AUTH_BLOCKED:
            retry = coordinator.block_todoist(now)
        next_time = retry if state.attempts < rules.COLLECT_ATTEMPTS else rules.next_collect(now, offset)
        await _finish_failed(env, state, code, now, next_time)
        return
    rows, skipped = rules.snapshot_rows(tasks, _key(state))
    if rows:
        await env.DB.prepare(sql.WRITE_PAGE.sql).bind(state.day, json.dumps(rows, ensure_ascii=False)).run()
    state.pages += 1
    state.skipped += skipped
    if cursor and state.pages >= rules.MAX_TASK_PAGES:
        state.partial = True
    if not cursor or state.partial:
        state.phase, state.cursor = COMPLETED, ""
    else:
        state.cursor = cursor


async def _completed_page(env: Any, coordinator: Any, state: State, now: int) -> None:
    db, tally = env.DB, rules.CompletedTally.loads(state.tally)
    if tally is None:
        state.phase = AGGREGATE
        return
    if state.completed_pages == 0:
        first = rules.week_shift(rules.iso_week(now), -WATCHED_WEEKS)
        rows = (await db.prepare(sql.OPEN_REVIEWS.sql).bind(first).all()).results
        state.watched = [[str(row["week"]), str(row["task_id"])] for row in rows]
    since = state.started - rules.COMPLETED_WINDOW
    query: dict[str, Any] = {"since": rules.rfc3339(since), "until": rules.rfc3339(state.started), "limit": 200}
    if state.cursor:
        query["cursor"] = state.cursor
    started = now_ms()
    upstream = await _get(env, coordinator, COMPLETED_PATH, query, now)
    outcome = upstream.outcome()
    code = "" if outcome.ok else _failure(outcome.status)
    items: list[dict[str, Any]] = []
    cursor = ""
    if not code:
        try:
            items, cursor = rules.parse_completed_page(upstream.body)
        except ValueError:
            code = GtdCode.MALFORMED_PAGE
    coordinator.record_step(_point(code, started), now)
    if code:
        if code == GtdCode.TODOIST_AUTH_BLOCKED:
            coordinator.block_todoist(now)
        # Completions are then unknown (completed_source 'none'); the snapshot itself still counts.
        state.tally, state.phase, state.cursor = None, AGGREGATE, ""
        _log(collect="completed_failed", day=state.day, code=code)
        return
    inbox = var(env, "TODOIST_DEFAULT_PROJECT_ID")
    review_ids = [task_id for _, task_id in state.watched]
    tally = rules.tally_completed(tally, items, since=since, inbox=inbox, review_ids=review_ids)
    state.completed_pages += 1
    if cursor and state.completed_pages < rules.MAX_COMPLETED_PAGES:
        state.tally, state.cursor = tally.dumps(), cursor
        return
    # More than MAX_COMPLETED_PAGES pages of completions: a count cut short would read as fact.
    state.tally = None if cursor else tally.dumps()
    state.phase, state.cursor = AGGREGATE, ""


async def _aggregate(env: Any, coordinator: Any, state: State, now: int, offset: int) -> None:
    db, day = env.DB, state.day
    yesterday = rules.shift(day, -1)
    first_week = rules.week_shift(rules.iso_week(now), -HISTORY_WEEKS)
    rows, before, closed, mail, history = await db.batch(
        [
            db.prepare(sql.SNAPSHOT_ROWS.sql).bind(day, rules.MAX_SNAPSHOT_ROWS),
            db.prepare(sql.SNAPSHOT_DAY.sql).bind(yesterday),
            db.prepare(sql.CLOSED_SINCE.sql).bind(yesterday, day),
            db.prepare(sql.MAIL_OPEN.sql).bind(now - rules.MAX_CARRYOVER_DAYS * DAY, now, day),
            db.prepare(sql.REVIEW_HISTORY.sql).bind(first_week, HISTORY_WEEKS + 1),
        ]
    )
    snapshot = [dict(row) for row in rows.results]
    tally = rules.CompletedTally.loads(state.tally)
    complete = not state.partial
    yesterday_ok = bool(before.results) and before.results[0]["status"] == SnapshotStatus.OK
    closed_1d = int(closed.results[0]["n"]) if yesterday_ok and complete else None
    mail_open = int(mail.results[0]["n"])
    every = rules.aggregate(
        snapshot,
        now=now,
        scope_project=None,
        completed=tally,
        complete=complete,
        closed_1d=closed_1d,
        mail_open=mail_open,
    )
    inbox_project = var(env, "TODOIST_DEFAULT_PROJECT_ID")
    inbox = None
    if inbox_project:
        inbox = rules.aggregate(snapshot, now=now, scope_project=inbox_project, completed=tally, complete=complete)
    status = SnapshotStatus.OK if complete else SnapshotStatus.PARTIAL
    statements = [db.prepare(sql.WRITE_DAILY.sql).bind(*_daily_values(day, Scope.ALL, every, now))]
    if inbox is not None:
        statements.append(db.prepare(sql.WRITE_DAILY.sql).bind(*_daily_values(day, Scope.INBOX, inbox, now)))
    code = "" if complete else GtdCode.PAGE_CAP
    statements.append(
        db.prepare(sql.SNAPSHOT_FINISH.sql).bind(status, len(snapshot), state.skipped, state.pages, code, now, day)
    )
    completions = {} if tally is None else tally.reviews
    weeks = {task_id: week for week, task_id in state.watched}
    for task_id, completed_at in sorted(completions.items()):
        if task_id in weeks:
            statements.append(db.prepare(sql.REVIEW_DONE.sql).bind(completed_at, now, weeks[task_id], task_id))
    await db.batch(statements)
    # The object's view for ops status().
    state.counters = rules.status_counters(every, inbox) if complete else {}
    if complete:
        state.last_ok_at = now
    _refresh_reviews(state, [dict(row) for row in history.results], completions)
    state.phase, state.cursor, state.tally = IDLE, "", None
    state.next_collect = rules.next_collect(now, offset)
    ops.ran(coordinator.sql, ops_rules.Job.GTD_SNAPSHOT, now)
    _log(
        collect=status,
        day=day,
        tasks=len(snapshot),
        skipped=state.skipped,
        pages=state.pages,
        completed_source=every.completed_source,
    )


def _daily_values(day: str, scope: Scope, daily: rules.Daily, now: int) -> list[Any]:
    return [
        day,
        str(scope),
        daily.open,
        daily.age_0_7,
        daily.age_8_14,
        daily.age_15_30,
        daily.age_31_plus,
        daily.oldest_days,
        daily.overdue,
        daily.undated,
        daily.created_7d,
        daily.completed_7d,
        daily.completed_source,
        daily.closed_1d,
        daily.mail_open,
        int(daily.complete),
        now,
    ]


def _refresh_reviews(state: State, history: list[dict[str, Any]], completions: dict[str, int]) -> None:
    """last_review_at and first_review_at from D1's recent reviews and the completions just seen."""
    done = [int(row["completed_at"]) for row in history if row.get("completed_at") is not None]
    done += list(completions.values())
    if state.last_review_at is not None:
        done.append(state.last_review_at)
    state.last_review_at = max(done) if done else None
    created = [int(row["created_at"]) for row in history if row.get("state") == ReminderState.CREATED]
    if state.first_review_at is not None:
        created.append(state.first_review_at)
    state.first_review_at = min(created) if created else None


async def _finish_failed(env: Any, state: State, code: str, now: int, next_time: int) -> None:
    await (
        env.DB.prepare(sql.SNAPSHOT_FINISH.sql)
        .bind(SnapshotStatus.FAILED, 0, state.skipped, state.pages, code, now, state.day)
        .run()
    )
    _log(collect="failed", day=state.day, code=code, attempt=state.attempts, pages=state.pages)
    state.phase, state.cursor, state.tally = IDLE, "", None
    state.next_collect = next_time


# ---- review --------------------------------------------------------------------------------


async def _review(env: Any, coordinator: Any, state: State, now: int) -> int:
    """Create this ISO week's review task if it is due; returns the next time to look."""
    db = env.DB
    window = rules.review_window(now)
    if window is None:
        return rules.next_review(now)
    end = window[1]

    def later(at: int) -> int:
        return at if at < end else rules.next_review(now)

    # Checked again every 10 minutes of the window, so switching the review on (or a pause ending) on
    # a Sunday evening still makes that week's task.
    if not flag(env, "GTD_REVIEW_ENABLED") or _todoist_paused(env):
        return later(now + REMINDER_CHECK_INTERVAL)
    # Only this job writes reviews and it runs in the alarm loop, so a week still 'sending' here was
    # interrupted mid-call: it becomes 'unknown' and is never resent.
    await db.prepare(sql.RECOVER_REVIEW.sql).bind(GtdCode.INTERRUPTED_REVIEW_CALL, now).run()
    if (wait := coordinator.todoist_wait(now)) is not None:
        return later(wait or now + REMINDER_CHECK_INTERVAL)
    week = rules.iso_week(now)
    row = await db.prepare(sql.REVIEW_WEEK.sql).bind(week).first()
    if row is not None:
        if row["state"] != ReminderState.FAILED or int(row["attempts"]) >= rules.REVIEW_MAX_ATTEMPTS:
            return rules.next_review(now)
        if int(row["next_attempt_at"]) > now:
            return later(int(row["next_attempt_at"]))
        attempts, subject, body, project = int(row["attempts"]), row["subject"], row["body"], row["project_id"]
        claim = await db.prepare(sql.CLAIM_REVIEW_RETRY.sql).bind(now, week, attempts, now).run()
    else:
        attempts, subject = 0, rules.review_title(week)
        body = await _review_body(env, coordinator, state, week, now)
        project = var(env, "TODOIST_REVIEW_PROJECT_ID") or var(env, "TODOIST_DEFAULT_PROJECT_ID")
        claim = await db.prepare(sql.CLAIM_REVIEW.sql).bind(week, project, subject, body, now, now).run()
    if claim.meta.changes != 1:
        return later(now + REMINDER_CHECK_INTERVAL)
    request = build_task_request(
        subject,
        body,
        project,
        todoist_request_id(subject, body, rules.REVIEW_SENDER + week),
        var(env, "TODOIST_API_KEY"),
    )
    coordinator.count_todoist_calls(TODOIST_MAX_ATTEMPTS, now)
    started = now_ms()
    result = await todoist.create_task(env, request, budget_ms=TODOIST_STEP_BUDGET * 1000)
    point = metrics.task_point(Step.REVIEW, result, now_ms() - started)
    review_state, code = _outcome(result.verdict)
    retry_at = now + rules.REVIEW_RETRY
    retries_left = review_state == ReminderState.FAILED and attempts + 1 < rules.REVIEW_MAX_ATTEMPTS
    await (
        db.prepare(sql.FINISH_REVIEW.sql)
        .bind(review_state, result.task_id, retry_at if retries_left else 0, code, now, week)
        .run()
    )
    coordinator.record_step(point, now)  # after FINISH_REVIEW: the created task is recorded first
    if review_state == ReminderState.CREATED and state.first_review_at is None:
        state.first_review_at = now
    _log(review=week, attempt=attempts + 1, state=review_state, error_code=code)
    return later(retry_at) if retries_left else rules.next_review(now)


def _outcome(verdict: TaskVerdict) -> tuple[ReminderState, str]:
    """The review's view of a create verdict (the daily reminder's rule)."""
    match verdict.result:
        case TaskResult.CREATED:
            return ReminderState.CREATED, ""
        case TaskResult.UNKNOWN:
            return ReminderState.UNKNOWN, GtdCode.REVIEW_RESULT_UNKNOWN
    return ReminderState.FAILED, GtdCode.REVIEW_CREATE_FAILED


async def _review_body(env: Any, coordinator: Any, state: State, week: str, now: int) -> str:
    db, today = env.DB, rules.day_of(now)
    days, attention, history = await db.batch(
        [
            db.prepare(sql.DAILY_RANGE.sql).bind(rules.shift(today, -13), today, 28),
            db.prepare(reminder_sql.ATTENTION_COUNT.sql).bind(source_id(env), now - ATTENTION_AGE_SECONDS),
            db.prepare(sql.REVIEW_HISTORY.sql).bind(rules.week_shift(week, -HISTORY_WEEKS), HISTORY_WEEKS + 1),
        ]
    )
    _refresh_reviews(state, [dict(row) for row in history.results], {})
    picked = rules.pick_days([dict(row) for row in days.results], today)
    report = coordinator.latest_ops_report()
    digest = ops_rules.digest(report, now)
    facts = rules.ReviewFacts(
        week=week,
        snapshot_day=picked["day"],
        all=picked["all"],
        inbox=picked["inbox"],
        all_week_ago=picked["all_week_ago"],
        inbox_week_ago=picked["inbox_week_ago"],
        attention_events=int(attention.results[0]["n"]),
        ops=digest,
        last_review_at=state.last_review_at,
        public_host=var(env, "TODOFY_PUBLIC_HOST"),
        dashboard_url=None if report is None else report.dashboard_url,
    )
    return rules.review_body(facts, now)


# ---- owner API -----------------------------------------------------------------------------

DEFAULT_API_DAYS = 30
MAX_API_DAYS = rules.DAILY_DAYS


async def daily(db: Any, days: int, now: int) -> dict[str, Any]:
    """GET /api/v1/gtd/daily: ``days`` UTC days up to today, oldest first, and the latest review."""
    today = rules.day_of(now)
    first = rules.shift(today, -(days - 1))
    rows, history = await db.batch(
        [
            db.prepare(sql.DAILY_RANGE.sql).bind(first, today, days * 2),
            db.prepare(sql.REVIEW_HISTORY.sql).bind(rules.week_shift(rules.iso_week(now), -HISTORY_WEEKS), 1),
        ]
    )
    latest = history.results[0] if history.results else None
    return {
        "days": rules.daily_api([dict(row) for row in rows.results], first, days),
        "latest_review": None
        if latest is None
        else {
            "week": latest["week"],
            "state": latest["state"],
            "created_at": rules.rfc3339(int(latest["created_at"])),
            "completed_at": None if latest["completed_at"] is None else rules.rfc3339(int(latest["completed_at"])),
        },
    }
