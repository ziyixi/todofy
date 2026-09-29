"""tools/backup_restore.py on host SQLite: parts made with the Worker's own statements and part writer
are checked against their manifest, turned into SQL and loaded into an empty database.

The Worker's real run (D1, R2, alarms) and the wrangler commands are covered by
tests/runtime/test_backup.py.
"""

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from todofy.core import backup as layout
from todofy.core.sql import backup as sql
from tools.backup_restore import (
    MANIFEST,
    MAX_STATEMENT_BYTES,
    PARTS,
    RestoreError,
    load_tables,
    main,
    row_statements,
    verify,
    write_sql,
)

MIGRATIONS = sorted((Path(__file__).parents[1] / "migrations").glob("*.sql"))
LATEST = MIGRATIONS[-1].name
PREFIX = "backups/2026-09-27T100000Z/"
# An additive migration made up for the tests, after every migration in the tree.
LATER_MIGRATION = ("9999_later.sql", "CREATE TABLE later (day TEXT PRIMARY KEY)")
LONG_PAYLOAD = json.dumps({"text": "长邮件'正文'" * 40_000})  # about 600 KB
LEGACY_TEXT = "旧\x00文本 it's " * 30_000  # a NUL forces the hex form


def database(*later: tuple[str, str]) -> sqlite3.Connection:
    """The schema with its migrations recorded as `wrangler d1 migrations apply` does, plus ``later``."""
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)")
    for name, statement in (*((migration.name, migration.read_text()) for migration in MIGRATIONS), *later):
        connection.executescript(statement)
        connection.execute("INSERT INTO d1_migrations (name) VALUES (?)", (name,))
    return connection


class SqliteWrangler:
    """`Wrangler.query` against a host SQLite database."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self.db = db

    def query(self, _db: str, statement: str) -> list[dict[str, Any]]:
        cursor = self.db.execute(statement)
        names = [column[0] for column in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def seed(db: sqlite3.Connection) -> None:
    event = (
        "INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, summary, todo_body,"
        " created_at, updated_at) VALUES ('mail-hero-personal', ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    for index in range(25):
        active = index % 5 == 0
        payload = LONG_PAYLOAD if index == 5 else json.dumps({"n": index}) if active else None
        summary = "摘要" * (30_000 if index == 7 else 3)
        values = (
            f"e{index:02d}",
            "0" * 64,
            payload,
            "failed_summary" if active else "complete",
            summary,
            "body",
            index,
            index,
        )
        db.execute(event, values)
        db.execute(
            "INSERT INTO event_transitions (event_id, at, from_state, to_state, actor)"
            " VALUES (?, ?, NULL, 'pending', 'worker')",
            (f"e{index:02d}", index),
        )
    db.execute(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model) VALUES ('e01', 1, '主题', '摘要', 'm')"
    )
    db.execute("INSERT INTO auth_failures (hour, count) VALUES ('2026-09-27T10', 3)")
    db.execute(
        "INSERT INTO owner_actions (owner, action_request_id, kind, request_hash, result_ref, http_status, created_at)"
        " VALUES ('owner@example.com', 'a1', 'recompute', 'h', ?, 200, 1)",
        (json.dumps({"report": "x" * 120_000}),),
    )
    db.execute("INSERT INTO legacy_mail_text (event_id, created_at, text) VALUES ('legacy:1', 1, ?)", (LEGACY_TEXT,))
    db.execute("INSERT INTO legacy_mail_text (event_id, created_at, text, expires_at) VALUES ('legacy:2', 2, 't', 9)")


def export(db: sqlite3.Connection, root: Path, table: sql.Table, prefix: str, page_rows: int = 4) -> dict:
    """What runtime/backup.py stores for one table: its pages (and deferred values), a part per two pages."""
    db.row_factory = sqlite3.Row
    max_rid = db.execute(sql.max_rowid(table)).fetchone()["n"] or 0
    parts, last, pages = [], 0, 0
    part = layout.Part()
    while rows := db.execute(sql.page(table), (last, max_rid, page_rows)).fetchall():
        for group in (
            layout.slices(rows, lambda row: bool(row["_deferred"]), sql.DEFERRED_ROWS) if table.deferred else [rows]
        ):
            rids = [row["_rid"] for row in group if table.deferred and row["_deferred"]]
            values = dict(db.execute(sql.deferred(table, len(rids)), rids).fetchall()) if rids else {}
            for row in group:
                part.add([values.get(row["_rid"]) if name == table.deferred else row[name] for name in table.columns])
        last, pages = rows[-1]["_rid"], pages + 1
        if pages % 2 == 0:
            parts.append(store(root, prefix, table, part, len(parts) + 1))
            part = layout.Part()
    if part.rows:
        parts.append(store(root, prefix, table, part, len(parts) + 1))
    db.row_factory = None
    return layout.table_entry(table.name, table.columns, table.key, max_rid, parts)


def store(root: Path, prefix: str, table: sql.Table, part: layout.Part, seq: int) -> dict:
    data, digest = part.finish()
    key = layout.part_key(prefix, table.name, seq)
    path = root / PARTS / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"key": key, "rows": part.rows, "bytes": len(data), "sha256": digest}


def backup_of(db: sqlite3.Connection, root: Path, schema_version: str = LATEST) -> None:
    tables = [export(db, root, table, PREFIX) for table in sql.TABLES.values()]
    data = layout.manifest(started_at=0, finished_at=60, schema_version=schema_version, tables=tables)
    (root / MANIFEST).write_bytes(data)


def dump(db: sqlite3.Connection) -> dict[str, list[tuple]]:
    return {
        table.name: db.execute(
            f"SELECT {', '.join(table.columns)} FROM {table.name} ORDER BY {', '.join(table.key)}"
        ).fetchall()
        for table in sql.TABLES.values()
    }


@pytest.fixture
def source() -> sqlite3.Connection:
    db = database()
    seed(db)
    return db


def test_backup_round_trips_into_an_empty_database(source, tmp_path):
    backup_of(source, tmp_path)
    out = tmp_path / "restore.sql"
    assert main(["sql", "--in", str(tmp_path), "--out", str(out)]) == 0
    assert out.stat().st_mode & 0o777 == 0o600
    statements = out.read_text().splitlines()[1:]
    assert max(len(line.encode()) for line in statements) <= MAX_STATEMENT_BYTES
    assert any(line.startswith("UPDATE mail_events SET payload = payload ||") for line in statements)
    assert any(line.startswith("UPDATE legacy_mail_text SET text = text ||") for line in statements)
    target = database()
    # Twice: a re-run (say after a partial load) changes nothing.
    for _ in range(2):
        target.executescript(out.read_text())
    assert dump(target) == dump(source)


def test_the_legacy_text_can_be_left_out(source, tmp_path):
    backup_of(source, tmp_path)
    manifest = json.loads((tmp_path / MANIFEST).read_text())
    [legacy] = [table for table in manifest["tables"] if table["name"] == sql.LEGACY_MAIL_TEXT.name]
    (tmp_path / PARTS / legacy["parts"][0]["key"]).unlink()  # not needed without the text
    with pytest.raises(RestoreError, match="legacy_mail_text"):
        load_tables(tmp_path, legacy_text=True)
    lines = write_sql(tmp_path, tmp_path / "restore.sql", legacy_text=False)
    assert [line.split()[1] for line in lines] == [name for name in sql.TABLES if name != sql.LEGACY_MAIL_TEXT.name]
    target = database()
    target.executescript((tmp_path / "restore.sql").read_text())
    assert target.execute("SELECT count(*) FROM legacy_mail_text").fetchone() == (0,)
    assert target.execute("SELECT count(*) FROM mail_events").fetchone() == (25,)
    assert verify(SqliteWrangler(target), "DB", tmp_path, legacy_text=False)[0]


def test_a_backup_made_after_a_later_migration_restores_with_its_legacy_text(source, tmp_path):
    # Every backup holds its own copy of the text, so no older copy can pin an older schema.
    backup_of(source, tmp_path, schema_version=LATER_MIGRATION[0])
    out = tmp_path / "restore.sql"
    assert main(["sql", "--in", str(tmp_path), "--out", str(out)]) == 0
    target = database(LATER_MIGRATION)
    target.executescript(out.read_text())
    assert dump(target) == dump(source)
    ok, lines = verify(SqliteWrangler(target), "DB", tmp_path, legacy_text=True)
    assert ok and lines[0] == f"PASS schema_version {LATER_MIGRATION[0]}"


def test_verify_accepts_a_target_with_later_migrations_but_not_an_older_one(source, tmp_path):
    # The documented restore applies every migration in the tree, which may be newer than the backup.
    backup_of(source, tmp_path)
    out = tmp_path / "restore.sql"
    write_sql(tmp_path, out, legacy_text=True)
    newer = database(LATER_MIGRATION)
    newer.executescript(out.read_text())
    ok, lines = verify(SqliteWrangler(newer), "DB", tmp_path, legacy_text=True)
    assert ok, lines
    assert lines[0] == f"PASS schema_version {LATEST} (later migrations applied: {LATER_MIGRATION[0]})"
    assert len(lines) == 1 + len(sql.TABLES) and all(line.startswith("PASS ") for line in lines)

    backup_of(source, tmp_path, schema_version=LATER_MIGRATION[0])
    older = database()
    older.executescript(out.read_text())
    ok, lines = verify(SqliteWrangler(older), "DB", tmp_path, legacy_text=True)
    assert not ok and lines[0] == f"FAIL schema_version {LATER_MIGRATION[0]} (not applied)"


@pytest.mark.parametrize("damage", ["flip_byte", "drop_part", "wrong_rows"])
def test_a_part_that_differs_from_the_manifest_is_refused(source, tmp_path, damage, capsys):
    backup_of(source, tmp_path)
    manifest = json.loads((tmp_path / MANIFEST).read_text())
    part = manifest["tables"][1]["parts"][0]
    path = tmp_path / PARTS / part["key"]
    if damage == "flip_byte":
        data = bytearray(path.read_bytes())
        data[len(data) // 2] ^= 1
        path.write_bytes(bytes(data))
    elif damage == "drop_part":
        path.unlink()
    else:
        part["rows"] += 1
        (tmp_path / MANIFEST).write_text(json.dumps(manifest))
    assert main(["sql", "--in", str(tmp_path), "--out", str(tmp_path / "restore.sql")]) == 1
    assert "sql FAIL" in capsys.readouterr().err


def test_long_values_are_appended_by_key_and_short_rows_stay_one_insert():
    table = {"name": "summaries", "columns": list(sql.SUMMARIES.columns), "key": ["event_id"]}
    short = row_statements(table, ["e1", 1, "s", "x", "m", "", 0])
    assert short == [
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id, imported)"
        " VALUES ('e1', 1, 's', 'x', 'm', '', 0) ON CONFLICT DO NOTHING;"
    ]
    statements = row_statements(table, ["e'1", 1, "s", "长" * 100_000, "m", "", 0])
    assert statements[0].endswith("VALUES ('e''1', 1, 's', '', 'm', '', 0) ON CONFLICT DO NOTHING;")
    assert all("WHERE event_id = 'e''1' AND length(CAST(summary AS BLOB)) = " in line for line in statements[1:])
    assert len(statements) == 5  # 300,000 bytes in pieces of at most 80,000
