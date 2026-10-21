"""The ops-v1 surface inside TodofyCore (contracts/ops-v1; core/ops.py has the rules).

The gateway's ``Ops`` entrypoint calls the coordinator's ``ops_*`` RPC methods, which use
this module. State lives in the object's SQLite only (not D1, not in backups): the guard
and the last run of each deferrable job. Losing it reads as a normal guard and jobs that
may run now.

D1 budget: ``status`` runs one batch of five bounded reads (STATUS_STATEMENTS); ``canary``
one primary-key read; ``set_guard`` none.
"""

from typing import Any

from todofy.core import ops as core
from todofy.core.backoff import DAY
from todofy.core.carryover import MAX_CARRYOVER_DAYS
from todofy.core.sql import mailbox as mailbox_sql
from todofy.core.sql import views
from todofy.core.vocab import ATTENTION_AGE_SECONDS
from todofy.runtime import backup, ledger
from todofy.runtime.config import flag, source_id, var

DO_SCHEMA = (
    # Absent row: normal. Times in epoch ms (the caller's own precision is kept).
    "CREATE TABLE IF NOT EXISTS ops_guard (id INTEGER PRIMARY KEY CHECK (id = 1), level TEXT NOT NULL,"
    " reason TEXT, until INTEGER, set_at INTEGER)",
    # The last run of each deferrable job (Unix seconds), for its bound.
    "CREATE TABLE IF NOT EXISTS ops_job_runs (job TEXT PRIMARY KEY, at INTEGER NOT NULL)",
)
STATUS_STATEMENTS = 5


def switches(env: Any) -> core.Switches:
    return core.Switches(maintenance=flag(env, "MAINTENANCE_MODE"), processing_paused=flag(env, "PROCESSING_PAUSED"))


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
    counts, attention, received, due, carried = await db.batch(
        [
            db.prepare(views.ACTIVE_COUNTS.sql).bind(source),
            db.prepare(views.ATTENTION_COUNT.sql).bind(source, now - ATTENTION_AGE_SECONDS),
            db.prepare(views.RECEIVED_SINCE.sql).bind(source, now - DAY),
            db.prepare(views.OLDEST_DUE.sql).bind(now),
            db.prepare(mailbox_sql.PENDING_BETWEEN.sql).bind(now - MAX_CARRYOVER_DAYS * DAY, now - DAY),
        ]
    )
    usage = coordinator.usage_facts(now)
    state = backup.status_facts(env, store, now)
    oldest = due.results[0]["at"]
    switch = switches(env)
    return core.status(
        core.Facts(
            now=now,
            maintenance=switch.maintenance,
            processing_paused=switch.processing_paused,
            active_events=sum(int(row["n"]) for row in counts.results),
            attention_events=int(attention.results[0]["n"]),
            received_24h=int(received.results[0]["n"]),
            oldest_due_at=None if oldest is None else int(oldest),
            carryover_open=int(carried.results[0]["n"]),
            gemini_used=usage["used_tokens"],
            gemini_reserved=usage["reserved_tokens"],
            gemini_budget=usage["token_budget"],
            gemini_calls=usage["calls"],
            backup_bound=state["bound"],
            backup_active=state["active"],
            backup_status=state["status"],
            last_backup_at=state["last_backup_at"],
            guard=guard(store),
            public_host=var(env, "TODOFY_PUBLIC_HOST"),
        )
    )


def unavailable(env: Any, store: Any, now: int) -> dict[str, Any]:
    """The status when the snapshot could not be read (D1 or storage failed)."""
    try:
        current = guard(store)
    except Exception:
        current = core.NORMAL
    return core.unavailable_status(now, switches(env), current, var(env, "TODOFY_PUBLIC_HOST"))
