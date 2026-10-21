"""The weekly backup job (runtime/backup.py) across a release that adds columns, and its Tasks section, on host
CPython: D1 and the object's SQLite are host SQLite (host_support.py), R2 a dict and the TASKS binding an in-memory
exportBackup. The whole job in workerd, restored, is tests/runtime/test_backup.py. Synthetic rows only.
"""

import asyncio
import gzip
import json
import types
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.host_support import D1, ObjectSql, stubbed_pyodide
from tests.unit.test_backup import D1_MIGRATIONS, MIGRATIONS
from todofy.core import backup as layout
from todofy.core.sql import backup as sql

NOW = int(datetime(2026, 10, 18, 10, 10, tzinfo=UTC).timestamp())  # a Sunday, ten minutes into the lease
# summaries as the release before 0007 exported it.
SUMMARIES_BEFORE = sql.SUMMARIES._replace(columns=sql.SUMMARIES.columns[:7])


class Bucket:
    """R2's put, head, list (by prefix, with or without a delimiter) and delete, in memory."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes, _options: Any = None) -> None:
        self.objects[key] = bytes(data)

    async def head(self, key: str) -> bytes | None:
        return self.objects.get(key)

    async def list(self, options: dict[str, Any]) -> Any:
        prefix = options["prefix"]
        keys = sorted(key for key in self.objects if key.startswith(prefix))
        if "delimiter" in options:
            prefixes = sorted({prefix + key[len(prefix) :].split("/")[0] + "/" for key in keys})
            return types.SimpleNamespace(delimitedPrefixes=prefixes, objects=[], truncated=False)
        return types.SimpleNamespace(objects=[types.SimpleNamespace(key=key) for key in keys], truncated=False)

    async def delete(self, keys: list[str]) -> None:
        for key in keys:
            self.objects.pop(key, None)


# Two Tasks tables, their columns and key, as Tasks' plan names them.
TASKS_TABLES = {"projects": (["id", "title"], ["id"]), "tasks": (["id", "title", "sort_order"], ["id"])}


class Tasks:
    """TasksApi.exportBackup (tasks/worker/src/backup.ts) over in-memory rows: rowid is a row's position, a page
    holds at most ``page_rows`` rows and is done once it reaches ``through`` or finds nothing."""

    def __init__(self) -> None:
        self.rows = {
            "projects": [["p1", "Synthetic project"]],
            "tasks": [[f"t{index}", f"Synthetic task {index}", index + 0.5] for index in range(5)],
        }
        self.calls: list[dict[str, Any]] = []
        self.change_sequence = 7
        self.failures = 0  # the next calls answer 503
        self.page_rows = 2

    async def exportBackup(self, body: str) -> Any:  # the JS method's name
        request = json.loads(body)
        self.calls.append(request)
        if self.failures:
            self.failures -= 1
            return types.SimpleNamespace(status=503, body='{"error":{}}')
        if request["table"] == "":
            tables = [
                {"name": name, "columns": columns, "key": key, "max_rowid": len(self.rows[name])}
                for name, (columns, key) in TASKS_TABLES.items()
            ]
            answer = {"schema_version": "0004_read_paths.sql", "change_sequence": self.change_sequence}
            answer["tables"] = tables
        else:
            after, through = request["after"], request["through"]
            rows = list(enumerate(self.rows[request["table"]], 1))
            page = [(rid, row) for rid, row in rows if after < rid <= through][: self.page_rows]
            last = page[-1][0] if page else after
            answer = {
                "rows": [row for _, row in page],
                "last": last,
                "done": not page or last >= through,
                "change_sequence": self.change_sequence,
            }
        return types.SimpleNamespace(status=200, body=json.dumps(answer))


class Job:
    def __init__(self, backup: Any) -> None:
        self.backup = backup
        self.d1 = D1()
        self.d1.db.execute(D1_MIGRATIONS)
        self.d1.db.executemany("INSERT INTO d1_migrations (name) VALUES (?)", [(path.name,) for path in MIGRATIONS])
        self.d1.db.execute(
            "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id)"
            " VALUES ('e1', 1, 'Synthetic subject', 'Synthetic summary', 'm', 't1')"
        )
        self.d1.db.commit()
        self.bucket = Bucket()
        self.tasks = Tasks()
        self.env = types.SimpleNamespace(DB=self.d1, BACKUPS=self.bucket, TASKS=self.tasks)
        self.store = ObjectSql()
        for statement in backup.DO_SCHEMA:
            self.store.exec(statement)

    def step(self) -> int | None:
        return asyncio.run(self.backup.run(self.env, self.store, NOW))

    def state(self) -> dict[str, Any]:
        return json.loads(self.store.exec("SELECT doc FROM backup_state").toArray()[0].doc)

    def finish(self) -> dict[str, Any]:
        """Run the job to its manifest, which it answers."""
        for _ in range(100):
            if self.step() is None:
                break
        state = self.state()
        assert state["last_status"] == "ok", state
        return json.loads(self.bucket.objects[state["last_key"] + layout.MANIFEST])

    def rows(self, manifest: dict[str, Any], table: str, section: str = "") -> tuple[list[str], list[list[Any]]]:
        """A table's manifest columns and the rows its parts hold (``section`` "tasks": a Tasks table)."""
        tables = manifest[section]["tables"] if section else manifest["tables"]
        [entry] = [entry for entry in tables if entry["name"] == table]
        parts = [gzip.decompress(self.bucket.objects[part["key"]]) for part in entry["parts"]]
        return entry["columns"], [json.loads(line) for part in parts for line in part.splitlines()]


@pytest.fixture
def job(monkeypatch: pytest.MonkeyPatch) -> Iterator[Job]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import backup

        stubs["clock"]["ms"] = NOW * 1000
        yield Job(backup)


def test_a_job_exports_the_columns_it_was_planned_with(job, monkeypatch):
    """A release that adds a column while a job runs (0007 added two to summaries) must not mix two row widths:
    the pages and the manifest entry keep the columns of the code that planned the job."""
    monkeypatch.setitem(sql.TABLES, "summaries", SUMMARIES_BEFORE)
    assert job.step() is not None  # the release before plans the job
    monkeypatch.setitem(sql.TABLES, "summaries", sql.SUMMARIES)  # this release exports and finishes it
    columns, rows = job.rows(job.finish(), "summaries")
    assert columns == list(SUMMARIES_BEFORE.columns)
    assert rows == [["e1", 1, "Synthetic subject", "Synthetic summary", "m", "t1", 0]]


def test_a_job_saved_without_its_columns_starts_over_under_a_new_prefix(job):
    """The release before saved no columns, so the parts it stored may have another width: the job starts over,
    and its incomplete prefix is deleted once the new manifest is stored."""
    old = layout.weekly_prefix(NOW - 600)
    part = old + "summaries/00001.ndjson.gz"
    job.bucket.objects[part] = gzip.compress(b'["e1",1,"s","s","m","t1",0]\n')
    cursor = {"table": "summaries", "max_rid": 1, "last_rid": 1, "done": True, "parts": [{"key": part, "rows": 1}]}
    saved = {
        "next_run": NOW - 600,
        "failed_jobs": 0,
        "last_status": "ok",
        "last_backup_at": NOW - 7 * 86400,
        "last_key": "",
        "last_bytes": 0,
        "last_rows": 0,
        "failed_at": 0,
        "error_code": "",
        "job": {"prefix": old, "started_at": NOW - 600, "planned": True, "schema_version": "0006", "cursors": [cursor]},
    }
    job.store.exec("INSERT INTO backup_state (id, doc) VALUES (1, ?)", json.dumps(saved))
    manifest = job.finish()
    columns, rows = job.rows(manifest, "summaries")
    assert columns == list(sql.SUMMARIES.columns) and len(rows[0]) == len(columns)
    assert manifest["started_at"] == layout.timestamp(NOW) and part not in job.bucket.objects


def saved_state(**fields: Any) -> str:
    """A backup_state document, as the release before this one saved it (no tasks_included)."""
    state = {
        "next_run": layout.next_run(NOW, skip_today=True),
        "failed_jobs": 0,
        "last_status": "ok",
        "last_backup_at": NOW - 7 * 86400,
        "last_key": "",
        "last_bytes": 0,
        "last_rows": 0,
        "failed_at": 0,
        "error_code": "",
        "job": None,
    }
    return json.dumps(state | fields)


def test_tasks_tables_follow_todofy_in_invocations_of_their_own(job):
    """The plan reads Tasks' plan once; an invocation that read Todofy's D1 makes no Tasks call, and one that
    reads Tasks spends the shared budget across its tables."""
    job.env.BACKUP_QUERY_BUDGET = "3"
    assert job.step() is not None  # the plan
    assert job.tasks.calls == [{"table": ""}]
    while True:
        statements, calls = len(job.d1.statements), len(job.tasks.calls)
        resume = job.step()
        read_todofy = any(sql.startswith("SELECT rowid AS _rid") for sql in job.d1.statements[statements:])
        tasks_calls = len(job.tasks.calls) - calls
        assert not (read_todofy and tasks_calls), "one invocation read both"
        assert tasks_calls <= 3
        if resume is None:
            break
    manifest = json.loads(job.bucket.objects[job.state()["last_key"] + layout.MANIFEST])
    assert [entry["name"] for entry in manifest["tasks"]["tables"]] == ["projects", "tasks"]
    columns, rows = job.rows(manifest, "tasks", "tasks")
    assert columns == TASKS_TABLES["tasks"][0] and rows == job.tasks.rows["tasks"]
    [entry] = [entry for entry in manifest["tasks"]["tables"] if entry["name"] == "tasks"]
    # Five rows, two per call, three calls per invocation: two parts.
    assert [part["rows"] for part in entry["parts"]] == [4, 1]
    assert entry["key"] == ["id"] and entry["max_rowid"] == 5
    assert all(part["key"].startswith(job.state()["last_key"] + "tasks/tasks/") for part in entry["parts"])
    assert job.state()["tasks_included"] is True


def test_the_manifest_records_tasks_change_sequence_and_totals(job):
    assert job.step() is not None  # the plan, at change 7
    job.tasks.change_sequence = 9  # an owner edit in Tasks while the job runs
    manifest = job.finish()
    tasks = manifest["tasks"]
    assert tasks["schema_version"] == "0004_read_paths.sql"
    assert tasks["change_sequence"] == {"start": 7, "end": 9}
    assert [entry["rows"] for entry in tasks["tables"]] == [1, 5]
    assert {entry["name"] for entry in manifest["tables"]} == set(sql.TABLES)  # Todofy's own tables are unchanged
    state = job.state()
    assert state["last_rows"] == sum(entry["rows"] for entry in manifest["tables"] + tasks["tables"])


def test_a_tasks_error_repeats_the_step_without_duplicating_rows(job):
    assert job.step() is not None  # the plan
    while not all(cursor["done"] for cursor in job.state()["job"]["cursors"] if cursor["source"] == "todofy"):
        job.step()
    job.tasks.failures = 1  # the first Tasks page
    assert job.step() is not None
    assert job.state()["job"]["errors"] == 1
    assert not any(cursor["parts"] for cursor in job.state()["job"]["cursors"] if cursor["source"] == "tasks")
    _, rows = job.rows(job.finish(), "tasks", "tasks")
    assert rows == job.tasks.rows["tasks"]


def test_a_failing_tasks_plan_plans_again_from_nothing(job):
    job.tasks.failures = 1
    assert job.step() is not None
    saved = job.state()["job"]
    assert saved["planned"] is False and saved["cursors"] == [] and saved["errors"] == 1
    manifest = job.finish()
    assert len(manifest["tables"]) == len(sql.TABLES) and len(manifest["tasks"]["tables"]) == 2


def test_without_the_tasks_binding_the_job_fails_at_once(job):
    del job.env.TASKS
    assert job.step() is None
    state = job.state()
    assert (state["last_status"], state["error_code"], state["failed_jobs"]) == ("failed", "tasks_unavailable", 1)
    assert state["next_run"] == NOW + 6 * 3600 and state["job"] is None


def test_the_first_backup_with_tasks_runs_at_once_then_weekly(job):
    """A state saved before Tasks was included starts a job at the next alarm, even though its weekly slot is
    days away; once a backup holds Tasks, the weekly slot rules again."""
    job.store.exec("INSERT INTO backup_state (id, doc) VALUES (1, ?)", saved_state())
    assert job.step() is not None  # started now
    job.finish()
    assert job.state()["tasks_included"] is True
    assert job.step() is None and job.state()["job"] is None
    assert job.backup.next_run(job.env, job.store) == layout.next_run(NOW, skip_today=True)


def test_a_failed_job_does_not_restart_at_once(job):
    job.store.exec(
        "INSERT INTO backup_state (id, doc) VALUES (1, ?)",
        saved_state(failed_jobs=1, last_status="failed", next_run=NOW + 3600),
    )
    assert job.step() is None and job.state()["job"] is None
    assert job.backup.next_run(job.env, job.store) == NOW + 3600


def test_a_job_planned_before_tasks_loads_and_is_followed_by_one_with_tasks(job):
    """The release before saved cursors without ``source`` or ``key``: they load as Todofy's. That job's manifest
    has no tasks section, so the next job starts at once."""
    old = layout.weekly_prefix(NOW - 60)
    cursors = [
        {"table": table.name, "max_rid": 0, "columns": list(table.columns), "last_rid": 0, "done": False, "parts": []}
        for table in sql.TABLES.values()
    ]
    planned = {"prefix": old, "started_at": NOW - 60, "planned": True, "schema_version": "0011", "cursors": cursors}
    job.store.exec("INSERT INTO backup_state (id, doc) VALUES (1, ?)", saved_state(job=planned))
    manifest = job.finish()
    assert "tasks" not in manifest and job.tasks.calls == []
    assert job.state()["tasks_included"] is False
    assert job.step() is not None  # the next job starts at once, with Tasks
    assert job.tasks.calls == [{"table": ""}]
