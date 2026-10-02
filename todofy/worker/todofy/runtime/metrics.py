"""Operating metrics inside the coordinator (core/metrics.py has the shapes and the rules).

- ``record``: one Analytics Engine point per upstream step (binding METRICS, optional)
  plus the step's share of the day's counters in the object's SQLite.
- ``flush``: after each UTC midnight, count the finished day's mail from
  event_transitions (a rowid walk from a cursor, so no row is read twice), add the
  step counters and write the day to D1 ``daily_metrics`` in one batch.
- ``daily``: the owner API's ``GET /api/v1/metrics/daily``.

Everything here is best effort. ``record`` never raises (a failed Analytics Engine or
counter write is only logged), and callers run it after the step's result is committed.
A lost object storage only loses the counters of the current day (counting then
restarts from the newest transition, and the first day recorded again is the next full
one); so does a database the cursor does not belong to (a restore, see ``flush``).
"""

import json
from collections import Counter
from typing import Any

from todofy.core import metrics as core
from todofy.core.backoff import DAY, MINUTE
from todofy.core.metrics import Step, StepPoint
from todofy.core.sql import metrics as sql
from todofy.core.vocab import EventState
from todofy.runtime.config import source_id
from todofy.runtime.gemini import GeminiResult
from todofy.runtime.interop import to_js
from todofy.runtime.todoist import CreateResult

DO_SCHEMA = (
    # Counters of days not yet written to D1, by UTC day of the event.
    "CREATE TABLE IF NOT EXISTS metric_counts (day TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL,"
    " PRIMARY KEY (day, key))",
    # Arrival-to-completion seconds of each completion, for the day's percentiles.
    "CREATE TABLE IF NOT EXISTS metric_latency (day TEXT NOT NULL, seconds INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS metric_latency_day ON metric_latency (day, seconds)",
    # cursor: the last event_transitions.id counted (NULL until the first flush), and
    # cursor_event/cursor_at: that row's event_id and time (NULL for cursor 0, an empty
    # ledger), so a flush notices a database the cursor does not belong to;
    # flushed_day: the last day written to D1 or skipped as incomplete.
    "CREATE TABLE IF NOT EXISTS metric_flush (id INTEGER PRIMARY KEY CHECK (id = 1),"
    " next_at INTEGER NOT NULL DEFAULT 0, cursor INTEGER, cursor_event TEXT, cursor_at INTEGER, flushed_day TEXT)",
    "INSERT INTO metric_flush (id) VALUES (1) ON CONFLICT DO NOTHING",
)
ADD_COUNT = (
    "INSERT INTO metric_counts (day, key, value) VALUES (?, ?, ?)"
    " ON CONFLICT (day, key) DO UPDATE SET value = value + excluded.value"
)

# A day has a few hundred transitions; three pages leave most of the invocation's
# D1 query allowance (50 on Workers Free) to the ledger step and the other ticks.
WALK_PAGE = 500
WALK_PAGES = 3
DAYS_PER_FLUSH = 7
# The written day is complete a little after midnight; late transitions of the old day
# that commit after a new day's row are rare and dropped (the walk never goes back).
FLUSH_OFFSET = 5 * MINUTE
CONTINUE = MINUTE
KEEP_DAYS = 400
EXPIRE_BATCH = 100
DEFAULT_API_DAYS = 30
MAX_API_DAYS = 90
# Eight fixed keys plus one per Gemini model (GEMINI_MODELS lists at most five).
MAX_KEYS_PER_DAY = 16


def gemini_point(step: Step, result: GeminiResult, upstream_ms: int) -> StepPoint:
    verdict = result.verdict
    return StepPoint(
        step,
        "ok" if verdict.ok else "failed",
        code=verdict.code or "",
        model=result.model,
        upstream_ms=upstream_ms,
        tokens_in=result.prompt_tokens,
        tokens_out=max(result.tokens - result.prompt_tokens, 0),
        attempts=result.attempts,
    )


def task_point(step: Step, result: CreateResult, upstream_ms: int) -> StepPoint:
    verdict = result.verdict
    return StepPoint(step, verdict.result, code=verdict.code or "", upstream_ms=upstream_ms, attempts=result.attempts)


def write_point(env: Any, point: StepPoint) -> None:
    """One Analytics Engine data point; a missing binding or a failed write is only logged."""
    dataset = getattr(env, "METRICS", None)
    if dataset is None:
        return
    try:
        dataset.writeDataPoint(to_js(point.data_point()))
    except Exception as exc:  # metrics must never fail the step they describe
        print(json.dumps({"metrics": "write_failed", "error": type(exc).__name__}))


def record(env: Any, store: Any, point: StepPoint, now: int) -> None:
    """``store`` is the object's ``ctx.storage.sql``. Never raises: a failed counter write
    (a full or broken object storage) is only logged, and the day is then under-counted."""
    write_point(env, point)
    try:
        day = core.day_of(now)
        for key, value in point.counters().items():
            store.exec(ADD_COUNT, day, key, value)
    except Exception as exc:  # metrics must never fail the step they describe
        print(json.dumps({"metrics": "count_failed", "error": type(exc).__name__}))


def next_flush(store: Any) -> int:
    return int(store.exec("SELECT next_at FROM metric_flush WHERE id = 1").one().next_at)


def set_next_flush(store: Any, at: int) -> None:
    store.exec("UPDATE metric_flush SET next_at = ? WHERE id = 1", at)


async def flush(env: Any, store: Any, now: int) -> int:
    """Count and write every finished day not yet written; returns the next flush time."""
    db, today = env.DB, core.day_of(now)
    tomorrow = core.day_start(today) + DAY + FLUSH_OFFSET
    state = store.exec("SELECT cursor, cursor_event, cursor_at, flushed_day FROM metric_flush WHERE id = 1").one()
    if state.cursor is None or not await _cursor_holds(db, state):
        # Counting starts at the newest transition; today is seen only in part, so the
        # first day recorded is tomorrow, and the days in between stay "not recorded".
        newest = int((await db.prepare(sql.LAST_TRANSITION.sql).first())["id"])
        row = await db.prepare(sql.CURSOR_ROW.sql).bind(newest).first() if newest else None
        store.exec(
            "UPDATE metric_flush SET cursor = ?, cursor_event = ?, cursor_at = ?, flushed_day = ? WHERE id = 1",
            newest,
            None if row is None else row["event_id"],
            None if row is None else int(row["at"]),
            today,
        )
        _forget_before(store, core.shift(today, 1))
        return tomorrow
    first_open = core.shift(state.flushed_day, 1)
    if not await _walk(env, store, int(state.cursor), first_open, core.day_start(today)):
        return now + CONTINUE
    _forget_before(store, first_open)
    days = core.days_from(first_open, core.shift(today, -1))[:DAYS_PER_FLUSH]
    if not days:
        return tomorrow
    statements = [db.prepare(sql.WRITE_DAY.sql).bind(day, json.dumps(_day_values(store, day))) for day in days]
    statements.append(db.prepare(sql.EXPIRE_DAYS.sql).bind(core.day_of(now - KEEP_DAYS * DAY), EXPIRE_BATCH))
    await db.batch(statements)
    store.exec("UPDATE metric_flush SET flushed_day = ? WHERE id = 1", days[-1])
    _forget_before(store, core.shift(days[-1], 1))
    return now + CONTINUE if days[-1] < core.shift(today, -1) else tomorrow


async def _cursor_holds(db: Any, state: Any) -> bool:
    """Whether the cursor still points at the row it counted last (cursor 0 always does).

    Ids are reused after a restore (backup restore into a new database, or D1 Time Travel);
    walking on from a foreign cursor would skip the new rows up to it and write those days
    as zeros. A mismatch restarts counting instead (cloudflare-setup.md §7).
    """
    if int(state.cursor) == 0:
        return True
    row = await db.prepare(sql.CURSOR_ROW.sql).bind(int(state.cursor)).first()
    holds = (
        row is not None
        and state.cursor_at is not None
        and row["event_id"] == state.cursor_event
        and int(row["at"]) == int(state.cursor_at)
    )
    if not holds:
        print(json.dumps({"metrics": "cursor_reset", "cursor": int(state.cursor)}))
    return holds


async def _walk(env: Any, store: Any, cursor: int, first_open: str, midnight: int) -> bool:
    """Count transitions after ``cursor`` up to today's first; False if more remain than one flush reads."""
    db, source = env.DB, source_id(env)
    for _ in range(WALK_PAGES):
        rows = (await db.prepare(sql.TRANSITIONS_AFTER.sql).bind(source, cursor, WALK_PAGE).all()).results
        reached_today = False
        counts: Counter[tuple[str, str]] = Counter()
        latencies: list[tuple[str, int]] = []
        last: tuple[str, int] | None = None
        for row in rows:
            at = int(row["at"])
            if at >= midnight:
                reached_today = True
                break
            cursor, last = int(row["id"]), (row["event_id"], at)
            day = core.day_of(at)
            if day < first_open:
                continue  # a straggler of a day already written
            if row["canary_run_id"] is not None:
                continue  # a canary event (contracts/ops-v1) is not mail: never counted
            counts.update((day, key) for key in core.transition_keys(row["from_state"], row["to_state"]))
            if row["to_state"] == EventState.COMPLETE and row["received_at"] is not None:
                latencies.append((day, max(at - int(row["received_at"]), 0)))
        # No await between these writes, so the page and its cursor are stored together.
        for (day, key), value in counts.items():
            store.exec(ADD_COUNT, day, key, value)
        for day, seconds in latencies:
            store.exec("INSERT INTO metric_latency (day, seconds) VALUES (?, ?)", day, seconds)
        if last is not None:
            store.exec(
                "UPDATE metric_flush SET cursor = ?, cursor_event = ?, cursor_at = ? WHERE id = 1", cursor, *last
            )
        if reached_today or len(rows) < WALK_PAGE:
            return True
    return False


def _day_values(store: Any, day: str) -> dict[str, int]:
    counted = store.exec("SELECT key, value FROM metric_counts WHERE day = ?", day).toArray()
    latencies = store.exec("SELECT seconds FROM metric_latency WHERE day = ? ORDER BY seconds", day).toArray()
    return core.day_values({row.key: int(row.value) for row in counted}, [int(row.seconds) for row in latencies])


def _forget_before(store: Any, day: str) -> None:
    """Drop counters of days that are written, or were only partly seen."""
    store.exec("DELETE FROM metric_counts WHERE day < ?", day)
    store.exec("DELETE FROM metric_latency WHERE day < ?", day)


async def daily(db: Any, days: int, now: int) -> dict[str, Any]:
    """The owner API's DailyMetrics: the ``days`` finished UTC days before today, oldest first."""
    first, last = core.day_of(now - days * DAY), core.shift(core.day_of(now), -1)
    rows = (await db.prepare(sql.DAYS.sql).bind(first, last, days * MAX_KEYS_PER_DAY).all()).results
    return {"days": core.daily_series(((row["day"], row["key"], row["value"]) for row in rows), first, days)}


async def day_page(db: Any, size: int, before: str | None, now: int) -> tuple[list[dict[str, Any]], str | None]:
    """todofy.ui.v1 ListMetricDays: up to ``size`` finished UTC days before ``before`` (yesterday and older when
    None), newest first, as DailyMetricsDay dicts; and the day the next page ends before, or None on the last page.

    Days older than KEEP_DAYS are never listed (retention deletes them)."""
    yesterday = core.shift(core.day_of(now), -1)
    oldest = core.day_of(now - KEEP_DAYS * DAY)
    last = yesterday if before is None else min(core.shift(before, -1), yesterday)
    if last < oldest:
        return [], None
    first = max(core.shift(last, -(size - 1)), oldest)
    count = len(core.days_from(first, last))
    rows = (await db.prepare(sql.DAYS.sql).bind(first, last, count * MAX_KEYS_PER_DAY).all()).results
    series = core.daily_series(((row["day"], row["key"], row["value"]) for row in rows), first, count)
    return series[::-1], (first if first > oldest else None)
