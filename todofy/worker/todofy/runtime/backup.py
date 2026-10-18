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

Each job also copies the Tasks app's D1 under ``tasks/`` of the same prefix, read
through the TASKS binding (Tasks' exportBackup, which owns the column lists): one
call is one unit of the query budget, and an invocation that read Todofy's D1 does
not start on Tasks. The lease does not hold Tasks' owner writes, so the manifest
records Tasks' change sequence at the plan and at the end; tasks/tools/backup-restore.ts
warns when they differ. Without the binding the job fails (``tasks_unavailable``).
The first job after the release that added Tasks starts at the next alarm, not on
Sunday (``tasks_included``).
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
TASKS_UNAVAILABLE = "tasks_unavailable"
TASKS = "tasks"


class TasksUnavailable(Exception):
    """The Worker has no TASKS binding: the job fails at once, not after three tries."""


@dataclass
class Cursor:
    """One table of the running job, with the columns the code that planned the job exports: its pages and its
    manifest entry hold those, so a release that adds a column while a job runs cannot mix two row widths in
    one backup. A job saved without them, by the release before, does not load and starts over (_load)."""

    table: str
    max_rid: int
    columns: list[str]
    last_rid: int = 0
    done: bool = False
    parts: list[dict[str, Any]] = field(default_factory=list)
    source: str = "todofy"  # or TASKS: read through the TASKS binding, with Tasks' own key
    key: list[str] = field(default_factory=list)


@dataclass
class Job:
    prefix: str
    started_at: int
    planned: bool = False
    schema_version: str = ""
    errors: int = 0
    cursors: list[Cursor] = field(default_factory=list)
    tasks_schema: str = ""
    tasks_change_start: int = 0
    tasks_change_end: int = 0


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
    tasks_included: bool = False  # the last complete backup holds Tasks
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


def _due(state: State) -> int:
    """When the next job may start: at once while no complete backup holds Tasks yet (unless a job failed since
    the last success: then the usual retry), else ``next_run``."""
    return 0 if not state.tasks_included and state.failed_jobs == 0 else state.next_run


def holds_ledger(env: Any, store: Any, now: int) -> bool:
    """Whether a backup job keeps the ledger still (owner writes then get 503)."""
    return _bucket(env) is not None and _holding(_load(store), now)


def next_run(env: Any, store: Any) -> int | None:
    """When the next job is due (Unix seconds); None without the BACKUPS binding."""
    return None if _bucket(env) is None else _due(_load(store))


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
        "next_backup_at": None if status in ("disabled", "running") else at(max(_due(state), now)),
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
        if _due(state) > now or not may_start:
            return None
        state.job = Job(layout.weekly_prefix(now), now)
    job, retry_ms = state.job, CONTINUE_MS
    step = "plan" if not job.planned else "export" if not all(c.done for c in job.cursors) else "finish"
    try:
        match step:
            case "plan":
                await _plan(env, job)
            case "export":
                budget = Budget(integer(env, "BACKUP_QUERY_BUDGET", DEFAULT_QUERY_BUDGET), now_ms() + WALL_BUDGET_MS)
                read_todofy = False
                for cursor in job.cursors:
                    if cursor.done or not budget.left():
                        continue
                    if cursor.source != TASKS:
                        read_todofy = True
                        await _export_part(env.DB, bucket, job.prefix, cursor, budget)
                    elif read_todofy:
                        break  # Tasks starts in an invocation of its own
                    else:
                        await _export_tasks_part(env, bucket, job, cursor, budget)
            case _:
                await _finish(bucket, state, job, now)
        job.errors = 0
    except TasksUnavailable:
        _log(error="TasksUnavailable", step=step)
        _fail(state, now, TASKS_UNAVAILABLE)
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


async def _plan(env: Any, job: Job) -> None:
    """Fix the snapshot: the schema version and the max rowid of every table (one batch), then Tasks' plan. The
    job changes only once both answered, so a failed step plans again from nothing."""
    db = env.DB
    tables = list(sql.TABLES.values())
    results = await db.batch([db.prepare(sql.SCHEMA_VERSION), *(db.prepare(sql.max_rowid(t)) for t in tables)])
    plan = await _tasks_export(env, {"table": ""})
    job.schema_version = results[0].results[0]["name"]
    for table, result in zip(tables, results[1:], strict=True):
        job.cursors.append(Cursor(table.name, int(result.results[0]["n"] or 0), list(table.columns)))
    job.tasks_schema = str(plan["schema_version"])
    job.tasks_change_start = job.tasks_change_end = int(plan["change_sequence"])
    for table in plan["tables"]:
        columns, key = list(table["columns"]), list(table["key"])
        job.cursors.append(Cursor(str(table["name"]), int(table["max_rowid"]), columns, source=TASKS, key=key))
    job.planned = True
    _log(planned=job.prefix, tables=len(job.cursors))


async def _tasks_export(env: Any, request: dict[str, Any]) -> dict[str, Any]:
    """One TasksApi.exportBackup call: Tasks' plan, or a page of one of its tables."""
    service = getattr(env, "TASKS", None)
    if service is None:
        raise TasksUnavailable
    result = await service.exportBackup(json.dumps(request, separators=(",", ":")))
    if result.status != 200:
        raise RuntimeError(f"Tasks backup export answered {result.status}")
    return json.loads(str(result.body))


def _planned(cursor: Cursor) -> sql.Table:
    """The cursor's table with the columns its job was planned with."""
    return sql.TABLES[cursor.table]._replace(columns=tuple(cursor.columns))


async def _export_part(db: Any, bucket: Any, prefix: str, cursor: Cursor, budget: Budget) -> None:
    """Pages of one table into one part, until the table ends or the budget is spent."""
    table = _planned(cursor)
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


async def _export_tasks_part(env: Any, bucket: Any, job: Job, cursor: Cursor, budget: Budget) -> None:
    """Pages of one Tasks table into one part, under ``tasks/`` of the job's prefix (one call per page)."""
    part = layout.Part()
    last, done = cursor.last_rid, False
    while not done and budget.left():
        budget.queries -= 1
        page = await _tasks_export(env, {"table": cursor.table, "after": last, "through": cursor.max_rid})
        before = part.raw_bytes
        for row in page["rows"]:
            part.add(row)
        budget.raw_bytes -= part.raw_bytes - before
        last, done = int(page["last"]), bool(page["done"])
        job.tasks_change_end = max(job.tasks_change_end, int(page["change_sequence"]))
    if part.rows:
        data, digest = part.finish()
        key = layout.part_key(job.prefix + layout.TASKS_DIR, cursor.table, len(cursor.parts) + 1)
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
    tables, tasks_tables = [], []
    for cursor in job.cursors:
        if cursor.source == TASKS:
            entry = layout.table_entry(cursor.table, cursor.columns, cursor.key, cursor.max_rid, cursor.parts)
            tasks_tables.append(entry)
            continue
        table = _planned(cursor)
        tables.append(layout.table_entry(table.name, table.columns, table.key, cursor.max_rid, cursor.parts))
    # A job the release before planned holds no Tasks: the manifest then has no tasks section.
    tasks = (
        layout.tasks_section(job.tasks_schema, job.tasks_change_start, job.tasks_change_end, tasks_tables)
        if tasks_tables
        else None
    )
    data = layout.manifest(
        started_at=job.started_at, finished_at=finished, schema_version=job.schema_version, tables=tables, tasks=tasks
    )
    await bucket.put(job.prefix + layout.MANIFEST, data, {"httpMetadata": {"contentType": "application/json"}})
    state.job, state.failed_jobs, state.last_status, state.error_code = None, 0, "ok", ""
    state.last_backup_at, state.last_key = finished, job.prefix
    state.last_bytes = sum(table["bytes"] for table in tables + tasks_tables) + len(data)
    state.last_rows = sum(table["rows"] for table in tables + tasks_tables)
    state.tasks_included = tasks is not None
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
