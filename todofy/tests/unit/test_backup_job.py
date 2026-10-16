"""The weekly backup job (runtime/backup.py) across a release that adds columns, on host CPython: D1 and the
object's SQLite are host SQLite (plus_support.py) and R2 a dict. The whole job in workerd, restored, is
tests/runtime/test_backup.py. Synthetic rows only.
"""

import asyncio
import gzip
import json
import types
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.unit.plus_support import D1, ObjectSql, stubbed_pyodide
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
        self.env = types.SimpleNamespace(DB=self.d1, BACKUPS=self.bucket)
        self.store = ObjectSql()
        for statement in backup.DO_SCHEMA:
            self.store.exec(statement)

    def step(self) -> int | None:
        return asyncio.run(self.backup.run(self.env, self.store, NOW))

    def finish(self) -> dict[str, Any]:
        """Run the job to its manifest, which it answers."""
        for _ in range(100):
            if self.step() is None:
                break
        state = json.loads(self.store.exec("SELECT doc FROM backup_state").toArray()[0].doc)
        assert state["last_status"] == "ok", state
        return json.loads(self.bucket.objects[state["last_key"] + layout.MANIFEST])

    def rows(self, manifest: dict[str, Any], table: str) -> tuple[list[str], list[list[Any]]]:
        """A table's manifest columns and the rows its parts hold."""
        [entry] = [entry for entry in manifest["tables"] if entry["name"] == table]
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
