"""Weekly D1 -> R2 backup, run by the coordinator's alarm loop (core/backup.py has the layout).

A job starts when ``next_run`` is due (Sunday 10:00 UTC, or "due now" while the
object's storage has no backup state yet) and spans several alarm invocations.
While it runs it holds the ledger: the alarm makes no ledger step and no
reminder, report or retention tick, and owner writes get 503 ``unavailable``,
so pages read in different invocations form one snapshot. Webhooks still land;
their rows are newer than the snapshot's max rowid. Newsletter requests may
still write their counters and on-demand reports. The hold ends with the job,
or LEASE seconds after it started whatever happens.

Each invocation reads at most ``BACKUP_QUERY_BUDGET`` D1 statements (default 30:
the Free plan allows 50 per invocation and the loop needs a few of its own) and
about RAW_BUDGET bytes, and stores each table it read as one gzip part. The
cursor (DO SQLite) moves only after its part is stored, so an eviction or an
error repeats that invocation's pages and overwrites the same keys.

Every job writes every table (``legacy_mail_text`` too) under its own prefix
(core/backup.py) and never deletes or rewrites an earlier backup, so a failed job
cannot cost a complete one. After a manifest is written, all but the newest
KEEP_WEEKLY complete backups are deleted, with every incomplete prefix older than
the new one: a row that D1 retention deleted leaves R2 with the last backup that
still holds it.
"""

import json
from dataclasses import asdict, dataclass, field
from typing import Any

from todofy.core import backup as layout
from todofy.core.backoff import HOUR, MINUTE
from todofy.core.metrics import Step, StepPoint
from todofy.core.sql import backup as sql
from todofy.runtime import metrics
from todofy.runtime.config import integer
from todofy.runtime.interop import now_ms

DO_SCHEMA = ("CREATE TABLE IF NOT EXISTS backup_state (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL)",)
LEASE = 30 * MINUTE
CONTINUE_MS = 1000
ERROR_RETRY_MS = MINUTE * 1000
MAX_ERRORS = 3  # consecutive failed invocations before the job is given up
FAILED_RETRY = 6 * HOUR
MAX_FAILED_JOBS = 3  # then wait for the next weekly slot
DEFAULT_QUERY_BUDGET = 30
RAW_BUDGET = 24 << 20
WALL_BUDGET_MS = 15_000
MAX_LIST_PAGES = 10
STORAGE_ERROR = "storage_error"
LEASE_EXPIRED = "lease_expired"


@dataclass
class Cursor:
    """One table of the running job."""

    table: str
    max_rid: int
    last_rid: int = 0
    done: bool = False
    parts: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Job:
    prefix: str
    started_at: int
    planned: bool = False
    schema_version: str = ""
    errors: int = 0
    cursors: list[Cursor] = field(default_factory=list)


@dataclass
class State:
    next_run: int = 0
    failed_jobs: int = 0  # since the last success
    last_status: str = "never"  # never | ok | failed
    last_backup_at: int = 0
    last_key: str = ""
    last_bytes: int = 0
    last_rows: int = 0
    failed_at: int = 0
    error_code: str = ""
    job: Job | None = None


@dataclass
class Budget:
    queries: int
    deadline_ms: int
    raw_bytes: int = RAW_BUDGET

    def left(self) -> bool:
        return self.queries > 0 and self.raw_bytes > 0 and now_ms() < self.deadline_ms


def _load(store: Any) -> State:
    rows = store.exec("SELECT doc FROM backup_state WHERE id = 1").toArray()
    if not rows:
        return State()
    try:
        doc = json.loads(rows[0].doc)
        job = doc.pop("job")
        if job is not None:
            job = Job(**{**job, "cursors": [Cursor(**cursor) for cursor in job["cursors"]]})
        return State(**doc, job=job)
    except (ValueError, TypeError, KeyError):
        # Written by another version: start over (the next job is then due now).
        return State()


def _save(store: Any, state: State) -> None:
    store.exec(
        "INSERT INTO backup_state (id, doc) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc",
        json.dumps(asdict(state)),
    )


def _bucket(env: Any) -> Any | None:
    return getattr(env, "BACKUPS", None)


def _log(**fields: Any) -> None:
    # Keys, counts and codes only: never row content.
    print(json.dumps({"backup": fields}))


def _holding(state: State, now: int) -> bool:
    return state.job is not None and now - state.job.started_at <= LEASE


def holds_ledger(env: Any, store: Any, now: int) -> bool:
    """Whether a backup job keeps the ledger still (owner writes then get 503)."""
    return _bucket(env) is not None and _holding(_load(store), now)


def next_run(env: Any, store: Any) -> int | None:
    """When the next job is due (Unix seconds); None without the BACKUPS binding."""
    return None if _bucket(env) is None else _load(store).next_run


def last_backup_at(store: Any) -> int | None:
    """When the last complete backup finished (Unix seconds), or None."""
    return _load(store).last_backup_at or None


def status_facts(env: Any, store: Any, now: int) -> dict[str, Any]:
    """What ops status() reports: binding present, a job holding the ledger, the overview
    status and the last complete backup."""
    state = _load(store)
    bound = _bucket(env) is not None
    active = bound and _holding(state, now)
    return {
        "bound": bound,
        "active": active,
        "status": "disabled" if not bound else "running" if active else state.last_status,
        "last_backup_at": state.last_backup_at or None,
    }


def overview(env: Any, store: Any, now: int) -> dict[str, Any]:
    """The Overview's ``backup`` object (OpenAPI BackupStatus)."""
    state = _load(store)

    def at(seconds: int) -> str | None:
        return layout.timestamp(seconds) if seconds else None

    if _bucket(env) is None:
        status = "disabled"
    elif _holding(state, now):
        status = "running"
    else:
        status = state.last_status
    return {
        "status": status,
        "last_backup_at": at(state.last_backup_at),
        "last_backup_key": state.last_key or None,
        "last_backup_bytes": state.last_bytes,
        "last_backup_rows": state.last_rows,
        "last_failure_at": at(state.failed_at),
        "last_error_code": state.error_code or None,
        "next_backup_at": None if status in ("disabled", "running") else at(max(state.next_run, now)),
    }


async def run(env: Any, store: Any, now: int, *, may_start: bool = True) -> int | None:
    """Start or continue the job: the epoch ms to continue at while it holds the ledger, else None.

    ``may_start`` False (an ops guard defers the weekly backup) only holds back a new job; a
    running one always continues, since it holds the ledger until it ends."""
    bucket = _bucket(env)
    if bucket is None:
        return None
    state = _load(store)
    if state.job is None:
        if state.next_run > now or not may_start:
            return None
        state.job = Job(layout.weekly_prefix(now), now)
    job, retry_ms = state.job, CONTINUE_MS
    step = "plan" if not job.planned else "export" if not all(c.done for c in job.cursors) else "finish"
    try:
        match step:
            case "plan":
                await _plan(env.DB, job)
            case "export":
                budget = Budget(integer(env, "BACKUP_QUERY_BUDGET", DEFAULT_QUERY_BUDGET), now_ms() + WALL_BUDGET_MS)
                for cursor in job.cursors:
                    if not cursor.done and budget.left():
                        await _export_part(env.DB, bucket, job.prefix, cursor, budget)
            case _:
                await _finish(bucket, state, job, now)
        job.errors = 0
    except Exception as exc:
        # D1 or R2 failed (or a bug): the step runs again later from the cursors of the parts stored so far.
        job.errors += 1
        retry_ms = ERROR_RETRY_MS
        _log(error=type(exc).__name__, step=step, errors=job.errors)
        if job.errors >= MAX_ERRORS:
            _fail(state, now, STORAGE_ERROR)
    if state.job is not None and not _holding(state, now_ms() // 1000):
        _fail(state, now, LEASE_EXPIRED)
    _save(store, state)
    if state.job is None:
        # The job ended in this invocation, stored or given up: one point with its wall time.
        took_ms = now_ms() - job.started_at * 1000
        metrics.write_point(env, StepPoint(Step.BACKUP, state.last_status, state.error_code, upstream_ms=took_ms))
        return None
    return now_ms() + retry_ms


def _fail(state: State, now: int, code: str) -> None:
    _log(failed=code, prefix=state.job.prefix if state.job else "")
    state.job = None
    state.failed_jobs += 1
    state.last_status, state.failed_at, state.error_code = "failed", now, code
    state.next_run = now + FAILED_RETRY if state.failed_jobs < MAX_FAILED_JOBS else layout.next_run(now)


async def _plan(db: Any, job: Job) -> None:
    """Fix the snapshot: the schema version and the max rowid of every table (one batch)."""
    tables = list(sql.TABLES.values())
    results = await db.batch([db.prepare(sql.SCHEMA_VERSION), *(db.prepare(sql.max_rowid(t)) for t in tables)])
    job.schema_version = results[0].results[0]["name"]
    for table, result in zip(tables, results[1:], strict=True):
        job.cursors.append(Cursor(table.name, int(result.results[0]["n"] or 0)))
    job.planned = True
    _log(planned=job.prefix, tables=len(tables))


async def _export_part(db: Any, bucket: Any, prefix: str, cursor: Cursor, budget: Budget) -> None:
    """Pages of one table into one part, until the table ends or the budget is spent."""
    table = sql.TABLES[cursor.table]
    part = layout.Part()
    last, done = cursor.last_rid, False
    while not done and budget.left():
        budget.queries -= 1
        rows = (await db.prepare(sql.page(table)).bind(last, cursor.max_rid, table.page_rows).all()).results
        done = len(rows) < table.page_rows
        groups = (
            list(layout.slices(rows, lambda row: bool(row["_deferred"]), sql.DEFERRED_ROWS))
            if table.deferred
            else [rows]
        )
        for index, group in enumerate(groups):
            if not group:
                continue
            values = await _deferred_values(db, table, group, budget)
            before = part.raw_bytes
            for row in group:
                part.add([values.get(row["_rid"]) if name == table.deferred else row[name] for name in table.columns])
            budget.raw_bytes -= part.raw_bytes - before
            last = int(group[-1]["_rid"])
            if index + 1 < len(groups) and not budget.left():
                done = False  # the rest of this page is read again next time
                break
    if part.rows:
        data, digest = part.finish()
        key = layout.part_key(prefix, table.name, len(cursor.parts) + 1)
        await bucket.put(
            key, data, {"httpMetadata": {"contentType": "application/gzip"}, "customMetadata": {"sha256": digest}}
        )
        cursor.parts.append({"key": key, "rows": part.rows, "bytes": len(data), "sha256": digest})
    cursor.last_rid, cursor.done = last, done


async def _deferred_values(db: Any, table: sql.Table, rows: Any, budget: Budget) -> dict[int, Any]:
    """The deferred column of the flagged rows (at most DEFERRED_ROWS), by rowid."""
    if table.deferred is None:
        return {}
    rids = [int(row["_rid"]) for row in rows if row["_deferred"]]
    if not rids:
        return {}
    budget.queries -= 1
    found = (await db.prepare(sql.deferred(table, len(rids))).bind(*rids).all()).results
    return {int(row["_rid"]): row["value"] for row in found}


async def _finish(bucket: Any, state: State, job: Job, now: int) -> None:
    """Write the manifest (it marks the backup complete), then apply retention."""
    finished = now_ms() // 1000
    tables = []
    for cursor in job.cursors:
        table = sql.TABLES[cursor.table]
        tables.append(layout.table_entry(table.name, table.columns, table.key, cursor.max_rid, cursor.parts))
    data = layout.manifest(
        started_at=job.started_at, finished_at=finished, schema_version=job.schema_version, tables=tables
    )
    await bucket.put(job.prefix + layout.MANIFEST, data, {"httpMetadata": {"contentType": "application/json"}})
    state.job, state.failed_jobs, state.last_status, state.error_code = None, 0, "ok", ""
    state.last_backup_at, state.last_key = finished, job.prefix
    state.last_bytes = sum(table["bytes"] for table in tables) + len(data)
    state.last_rows = sum(table["rows"] for table in tables)
    state.next_run = layout.next_run(now, skip_today=True)
    _log(done=job.prefix, rows=state.last_rows, bytes=state.last_bytes)
    try:
        await _apply_retention(bucket, job.prefix)
    except Exception as exc:
        # The backup is complete; the next one retries the cleanup.
        _log(retention_error=type(exc).__name__)


async def _apply_retention(bucket: Any, current: str) -> None:
    listed = await bucket.list({"prefix": layout.WEEKLY_ROOT, "delimiter": "/"})
    prefixes = [str(prefix) for prefix in listed.delimitedPrefixes]
    complete = set()
    for prefix in prefixes:
        if prefix < current and await bucket.head(prefix + layout.MANIFEST) is not None:
            complete.add(prefix)
    for prefix in layout.expired_prefixes(prefixes, complete, current):
        await _delete_prefix(bucket, prefix)
        _log(deleted=prefix)


async def _delete_prefix(bucket: Any, prefix: str) -> None:
    """Delete every object under ``prefix`` (a backup has a few dozen; bounded anyway)."""
    for _ in range(MAX_LIST_PAGES):
        listed = await bucket.list({"prefix": prefix, "limit": 1000})
        keys = [str(item.key) for item in listed.objects]
        if keys:
            await bucket.delete(keys)
        if not listed.truncated:
            return
    raise RuntimeError("too many objects under a backup prefix")
