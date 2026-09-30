"""The ops-v1 surface inside TodofyCore (contracts/ops-v1; core/ops.py has the rules).

The gateway's ``Ops`` entrypoint calls the coordinator's ``ops_*`` RPC methods, which use
this module. State lives in the object's SQLite only (not D1, not in backups): the guard,
the last run of each deferrable job and the dashboard's latest report. Losing it reads as a
normal guard, jobs that may run now and no report until the next one.

D1 budget: ``status`` runs one batch of six bounded reads (STATUS_STATEMENTS; the GTD ledger's
counters and signals come from the object's ``gtd_state``, runtime/gtd.py); ``canary``
one primary-key read; ``set_guard`` and ``store_report`` none.
"""

from typing import Any

from todofy.core import gtd as gtd_rules
from todofy.core import ops as core
from todofy.core.backoff import DAY, REMINDER_MAX_ATTEMPTS
from todofy.core.sql import intents as intent_sql
from todofy.core.sql import reminders as reminder_sql
from todofy.core.sql import views
from todofy.core.vocab import ATTENTION_AGE_SECONDS, ReminderState
from todofy.runtime import backup, ledger
from todofy.runtime.config import flag, source_id, var

DO_SCHEMA = (
    # Absent row: normal. Times in epoch ms (the caller's own precision is kept).
    "CREATE TABLE IF NOT EXISTS ops_guard (id INTEGER PRIMARY KEY CHECK (id = 1), level TEXT NOT NULL,"
    " reason TEXT, until INTEGER, set_at INTEGER)",
    # The last run of each deferrable job (Unix seconds), for its bound.
    "CREATE TABLE IF NOT EXISTS ops_job_runs (job TEXT PRIMARY KEY, at INTEGER NOT NULL)",
    # The dashboard's latest OpsReport as compact JSON; generated_at in epoch ms.
    "CREATE TABLE IF NOT EXISTS ops_report (id INTEGER PRIMARY KEY CHECK (id = 1), generated_at INTEGER NOT NULL,"
    " received_at INTEGER NOT NULL, doc TEXT NOT NULL CHECK (length(doc) <= 8192))",
)
STATUS_STATEMENTS = 6
# status() counts task intents that failed within this window (contracts/task-intent-v1).
INTENTS_FAILED_WINDOW = 7 * DAY


def switches(env: Any) -> core.Switches:
    return core.Switches(
        maintenance=flag(env, "MAINTENANCE_MODE"),
        processing_paused=flag(env, "PROCESSING_PAUSED"),
        force_pause_todoist=flag(env, "FORCE_PAUSE_TODOIST"),
        reminder_enabled=flag(env, "REMINDER_ENABLED"),
    )


# ---- guard ---------------------------------------------------------------------------------


def guard(store: Any) -> core.Guard:
    rows = store.exec("SELECT level, reason, until, set_at FROM ops_guard WHERE id = 1").toArray()
    if not rows:
        return core.NORMAL
    row = rows[0]
    until = None if row.until is None else int(row.until)
    set_at = None if row.set_at is None else int(row.set_at)
    return core.Guard(str(row.level), row.reason, until, set_at)


def set_guard(store: Any, wanted: core.GuardInput, now_ms: int) -> tuple[dict[str, Any], bool]:
    """Store ``wanted``; returns the GuardState and whether a shed guard ended or changed (then
    the jobs it deferred are due again, to be run or deferred under the new guard)."""
    current = guard(store)
    was_shed = current.shed(now_ms)
    if wanted.level == "normal":
        store.exec("DELETE FROM ops_guard WHERE id = 1")
        return core.guard_state(core.NORMAL, now_ms), was_shed
    if was_shed and (current.reason, current.until_ms) == (wanted.reason, wanted.until_ms):
        return core.guard_state(current, now_ms), False  # the same request again: unchanged
    store.exec(
        "INSERT INTO ops_guard (id, level, reason, until, set_at) VALUES (1, 'shed', ?, ?, ?)"
        " ON CONFLICT (id) DO UPDATE SET level = excluded.level, reason = excluded.reason,"
        " until = excluded.until, set_at = excluded.set_at",
        wanted.reason,
        wanted.until_ms,
        now_ms,
    )
    return core.guard_state(guard(store), now_ms), was_shed


def last_run(store: Any, job: core.Job) -> int | None:
    rows = store.exec("SELECT at FROM ops_job_runs WHERE job = ?", str(job)).toArray()
    return int(rows[0].at) if rows else None


def ran(store: Any, job: core.Job, now: int) -> None:
    store.exec(
        "INSERT INTO ops_job_runs (job, at) VALUES (?, ?) ON CONFLICT (job) DO UPDATE SET at = excluded.at",
        str(job),
        now,
    )


def defer_until(store: Any, job: core.Job, now: int) -> int | None:
    """None to run ``job`` now; else the Unix time to reconsider it (a shed guard holds it)."""
    return core.defer_until(guard(store), now, last_run(store, job), core.JOB_BOUND[job])


def backup_defer_until(store: Any, now: int) -> int | None:
    """None when a new backup job may start; else when to reconsider (the last complete backup
    is younger than BACKUP_BOUND and the guard is shed). A running job is never held."""
    last = backup.last_backup_at(store)
    return core.defer_until(guard(store), now, last, core.BACKUP_BOUND)


# ---- report --------------------------------------------------------------------------------


def latest_report(store: Any) -> core.Report | None:
    rows = store.exec("SELECT doc FROM ops_report WHERE id = 1").toArray()
    return core.stored_report(str(rows[0].doc)) if rows else None


def store_report(store: Any, received: core.Report, now: int) -> dict[str, Any]:
    """Replace the stored report unless it has a later generated_at; the OpsReportReceipt."""
    kept = latest_report(store)
    if kept is not None and kept.generated_ms > received.generated_ms:
        return core.receipt(False, kept)
    store.exec(
        "INSERT INTO ops_report (id, generated_at, received_at, doc) VALUES (1, ?, ?, ?)"
        " ON CONFLICT (id) DO UPDATE SET generated_at = excluded.generated_at,"
        " received_at = excluded.received_at, doc = excluded.doc",
        received.generated_ms,
        now,
        received.doc,
    )
    return core.receipt(True, received)


# ---- reads ---------------------------------------------------------------------------------


async def canary(env: Any, store: Any, event_id: str, now: int) -> dict[str, Any]:
    """CanaryResult of one event: a primary-key read."""
    row = await ledger.get(env.DB, source_id(env), event_id)
    fields = None
    if row is not None:
        fields = {
            "state": row.state,
            "last_error_code": row.last_error_code,
            "updated_at": row.updated_at,
            "canary_run_id": row.canary_run_id,
        }
    return core.canary_result(
        fields,
        maintenance=flag(env, "MAINTENANCE_MODE"),
        processing_paused=flag(env, "PROCESSING_PAUSED"),
        backup_active=backup.holds_ledger(env, store, now),
    )


async def status(env: Any, coordinator: Any, now: int) -> dict[str, Any]:
    """OpsStatus from one batch of STATUS_STATEMENTS bounded reads plus the object's storage."""
    db, source, store = env.DB, source_id(env), coordinator.sql
    today = core.timestamp(now)[:10]
    counts, attention, received, due, day, intent_counts = await db.batch(
        [
            db.prepare(views.ACTIVE_COUNTS.sql).bind(source),
            db.prepare(views.ATTENTION_COUNT.sql).bind(source, now - ATTENTION_AGE_SECONDS),
            db.prepare(views.RECEIVED_SINCE.sql).bind(source, now - DAY),
            db.prepare(views.OLDEST_DUE.sql).bind(now),
            db.prepare(reminder_sql.REMINDER_DAY.sql).bind(today),
            db.prepare(intent_sql.COUNTS.sql).bind(now - INTENTS_FAILED_WINDOW),
        ]
    )
    intent_row = intent_counts.results[0]
    usage = coordinator.usage_facts(now)
    state = backup.status_facts(env, store, now)
    # The GTD ledger's counters and signals come from the object's storage too (no D1 read).
    ledger_facts = coordinator.gtd_facts()
    reminder = day.results[0] if day.results else None
    oldest = due.results[0]["at"]
    switch = switches(env)
    return core.status(
        core.Facts(
            now=now,
            maintenance=switch.maintenance,
            processing_paused=switch.processing_paused,
            force_pause_todoist=switch.force_pause_todoist,
            reminder_enabled=switch.reminder_enabled,
            active_events=sum(int(row["n"]) for row in counts.results),
            attention_events=int(attention.results[0]["n"]),
            received_24h=int(received.results[0]["n"]),
            oldest_due_at=None if oldest is None else int(oldest),
            reminder_state=None if reminder is None else str(reminder["state"]),
            reminder_attempts=0 if reminder is None else int(reminder["attempts"]),
            reminder_retries_left=reminder is not None
            and reminder["state"] == ReminderState.FAILED
            and int(reminder["attempts"]) < REMINDER_MAX_ATTEMPTS,
            gemini_used=usage["used_tokens"],
            gemini_reserved=usage["reserved_tokens"],
            gemini_budget=usage["token_budget"],
            gemini_calls=usage["calls"],
            todoist_blocked_until=usage["todoist_blocked_until"],
            todoist_window_calls=usage["todoist_window_calls"],
            todoist_window_limit=usage["todoist_window_limit"],
            backup_bound=state["bound"],
            backup_active=state["active"],
            backup_status=state["status"],
            last_backup_at=state["last_backup_at"],
            guard=guard(store),
            public_host=var(env, "TODOFY_PUBLIC_HOST"),
            gtd_counters=ledger_facts.counters,
            gtd_stale_seconds=gtd_rules.snapshot_age(ledger_facts, now),
            review_enabled=gtd_rules.review_watched(ledger_facts),
            review_age_days=gtd_rules.review_age_days(ledger_facts, now),
            intents_pending=int(intent_row["pending"]),
            intents_failed_7d=int(intent_row["failed"]),
        )
    )


def unavailable(env: Any, store: Any, now: int) -> dict[str, Any]:
    """The status when the snapshot could not be read (D1 or storage failed)."""
    try:
        current = guard(store)
    except Exception:
        current = core.NORMAL
    return core.unavailable_status(now, switches(env), current, var(env, "TODOFY_PUBLIC_HOST"))
