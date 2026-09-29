"""The backup's pure parts (core/backup.py) and its generated D1 statements (core/sql/backup.py)."""

import gzip
import hashlib
import json
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from todofy.core import backup
from todofy.core.sql import backup as sql

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
# What `wrangler d1 migrations apply` creates (wrangler 4.142.0).
D1_MIGRATIONS = (
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,"
    " applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
)


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    connection.execute(D1_MIGRATIONS)
    for migration in MIGRATIONS:
        connection.executescript(migration.read_text())
        connection.execute("INSERT INTO d1_migrations (name) VALUES (?)", (migration.name,))
    yield connection
    connection.close()


def plan(db: sqlite3.Connection, statement: str) -> list[str]:
    return [row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {statement}", (None,) * statement.count("?"))]


def utc(text: str) -> int:
    return int(datetime.fromisoformat(text).replace(tzinfo=UTC).timestamp())


def test_every_table_is_backed_up_with_all_its_columns_and_its_primary_key(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert set(sql.TABLES) == tables - {"d1_migrations", "sqlite_sequence"}
    for table in sql.TABLES.values():
        info = db.execute(f"PRAGMA table_info({table.name})").fetchall()
        assert table.columns == tuple(row[1] for row in info), table.name
        assert table.key == tuple(row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]), table.name


@pytest.mark.parametrize("table", sql.TABLES.values(), ids=lambda table: table.name)
def test_pages_are_rowid_range_searches(db, table):
    assert plan(db, sql.page(table)) == [f"SEARCH {table.name} USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)"]
    assert all("SCAN" not in step for step in plan(db, sql.max_rowid(table)))


def test_deferred_payloads_are_read_by_rowid(db):
    for count in (1, sql.DEFERRED_ROWS):
        assert plan(db, sql.deferred(sql.MAIL_EVENTS, count)) == [
            "SEARCH mail_events USING INTEGER PRIMARY KEY (rowid=?)"
        ]
    assert sql.MAIL_EVENTS.deferred == "payload"
    assert all(table.deferred is None for table in sql.TABLES.values() if table is not sql.MAIL_EVENTS)


def test_a_page_walks_the_snapshot_once_and_flags_payloads(db):
    for index in range(5):
        payload = "{}" if index % 2 else None
        db.execute(
            "INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, created_at, updated_at)"
            " VALUES ('s', ?, ?, ?, ?, 1, 1)",
            (f"e{index}", "0" * 64, payload, "pending" if payload else "complete"),
        )
    seen, last = [], 0
    while rows := db.execute(sql.page(sql.MAIL_EVENTS), (last, 4, 2)).fetchall():
        seen += [(row[0], row[4]) for row in rows]  # _rid, _deferred (in place of payload)
        last = rows[-1][0]
    assert seen == [(1, 0), (2, 1), (3, 0), (4, 1)]  # rowid 5 is newer than the snapshot
    assert db.execute(sql.SCHEMA_VERSION).fetchone() == (MIGRATIONS[-1].name,)


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        ("2026-09-29T08:00:00", "2026-10-04T10:00:00"),  # Tuesday
        ("2026-10-04T09:59:59", "2026-10-04T10:00:00"),  # Sunday before the slot
        ("2026-10-04T10:00:00", "2026-10-11T10:00:00"),  # at the slot: the next week
        ("2026-10-04T23:00:00", "2026-10-11T10:00:00"),
    ],
)
def test_next_run_is_the_next_sunday_ten_utc(now, expected):
    assert backup.next_run(utc(now)) == utc(expected)


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        ("2026-10-03T23:00:00", "2026-10-04T10:00:00"),  # Saturday: the next day's run still happens
        ("2026-10-04T04:00:00", "2026-10-11T10:00:00"),  # a retry done early on Sunday: not again at 10:00
        ("2026-10-04T10:00:40", "2026-10-11T10:00:00"),
    ],
)
def test_after_a_backup_the_same_day_is_skipped(now, expected):
    assert backup.next_run(utc(now), skip_today=True) == utc(expected)


def test_keys_and_timestamps():
    now = utc("2026-09-27T10:00:05")
    assert backup.weekly_prefix(now) == "backups/2026-09-27T100005Z/"
    assert (
        backup.part_key("backups/2026-09-27T100005Z/", "mail_events", 3)
        == "backups/2026-09-27T100005Z/mail_events/00003.ndjson.gz"
    )
    assert backup.timestamp(now) == "2026-09-27T10:00:05Z"


def test_every_job_has_its_own_prefix_in_time_order():
    # A second job on the same day (a first deploy early on Sunday, lost object state) must never
    # reuse, and so clear, the prefix of a complete backup.
    first, second = utc("2026-10-04T09:00:00"), utc("2026-10-04T10:00:00")
    assert backup.weekly_prefix(first) < backup.weekly_prefix(second)
    assert backup.weekly_prefix(first) < backup.weekly_prefix(first + 1)
    assert backup.weekly_prefix(utc("2026-09-27T23:59:59")) < backup.weekly_prefix(first)


def test_retention_keeps_the_newest_six_complete_backups():
    days = [f"backups/2026-0{month}-01/" for month in range(1, 10)]
    current = days[-1]
    incomplete = {days[3], days[6]}
    complete = set(days[:-1]) - incomplete
    expired = backup.expired_prefixes([*days, "backups/2027-01-01/"], complete, current)
    kept = {current, *(sorted(complete, reverse=True)[: backup.KEEP_WEEKLY - 1])}
    assert len(kept) == backup.KEEP_WEEKLY
    # Every older prefix not kept goes, incomplete ones included; nothing newer than the current one.
    assert expired == sorted(set(days) - kept)
    assert backup.expired_prefixes([current], set(), current) == []


@pytest.mark.parametrize(
    ("flags", "limit", "expected"),
    [
        ([], 2, []),
        ([0, 0, 0], 2, [[0, 0, 0]]),
        ([1, 0, 1, 1, 0, 1], 2, [[1, 0, 1], [1, 0, 1]]),
        ([1, 1, 1], 1, [[1], [1], [1]]),
        ([0, 1, 1, 1, 0], 2, [[0, 1, 1], [1, 0]]),
    ],
)
def test_slices_hold_at_most_limit_flagged_rows(flags, limit, expected):
    rows = list(range(len(flags)))
    got = [[flags[row] for row in group] for group in backup.slices(rows, lambda row: flags[row] == 1, limit)]
    assert got == expected


def test_a_part_is_gzip_ndjson_with_its_sha256():
    part = backup.Part()
    rows = [["s", "中文", None, 1], ["t", "x" * 100_000, 2**40, 0]]
    for row in rows:
        part.add(row)
    data, digest = part.finish()
    assert digest == hashlib.sha256(data).hexdigest()
    lines = gzip.decompress(data).decode().splitlines()
    assert [json.loads(line) for line in lines] == rows
    assert part.rows == 2 and part.raw_bytes == len(gzip.decompress(data))
    assert len(data) < part.raw_bytes // 10


def test_manifest_lists_tables_with_totals():
    parts = [{"key": "k1", "rows": 2, "bytes": 10, "sha256": "a"}, {"key": "k2", "rows": 3, "bytes": 5, "sha256": "b"}]
    entry = backup.table_entry("auth_failures", ("hour", "count"), ("hour",), 9, parts)
    data = backup.manifest(started_at=0, finished_at=60, schema_version="0001_init.sql", tables=[entry])
    document = json.loads(data)
    assert document["format"] == "todofy-d1-backup-v1"
    assert (document["started_at"], document["created_at"]) == ("1970-01-01T00:00:00Z", "1970-01-01T00:01:00Z")
    assert document["tables"][0] | {"parts": []} == {
        "name": "auth_failures",
        "columns": ["hour", "count"],
        "key": ["hour"],
        "max_rowid": 9,
        "rows": 5,
        "bytes": 15,
        "parts": [],
    }
    assert set(document) == {"format", "started_at", "created_at", "schema_version", "tables"}
