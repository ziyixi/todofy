"""Tests for flowday_migrate.py with synthetic container-era databases only (never a real copy).

    python3 -m unittest discover -s flowday/deploy/migrate -p 'test_*.py'

The round trip runs the pinned wrangler against a local D1 (flowday/worker/node_modules; `npm ci` there first).
Without it those tests skip, unless FLOWDAY_MIGRATE_REQUIRE_WRANGLER=1 (CI) makes a missing wrangler a failure.
A fake wrangler backed by a plain SQLite file stands in for the remote D1 (its JSON shapes, Time Travel).
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import flowday_migrate as tool

WRANGLER = tool.WORKER / "node_modules" / ".bin" / "wrangler"
REQUIRE_WRANGLER = os.environ.get("FLOWDAY_MIGRATE_REQUIRE_WRANGLER") == "1"

# Markers that must never appear in the tool's output: every synthetic row carries one.
MARKER = "SYNTH-ROW"
FAKE_TODOIST_KEY = "synthetic-todoist-key-0123456789abcdef"
# Text that SQL tooling tends to mangle: quotes, comment and statement syntax, wrangler's transaction trimmer,
# unicode (CJK, combining marks, right-to-left, emoji with ZWJ and skin tones), every control character, CRLF.
TRICKY = [
    "",
    "'",
    "''''",
    'it\'s "quoted" `back` [bracket] $$dollar$$ \\backslash\\ %percent_',
    "x'); DROP TABLE tasks; --",
    "/* not a comment */ -- nor this ; ;; ;",
    "BEGIN TRANSACTION; COMMIT; BEGIN TRANSACTION;\nCOMMIT;",
    "中文任务\uff1a写周报\uff08第二版\uff09",
    "e\u0301 cafe\u0301 \u05e9\u05dc\u05d5\u05dd \u0645\u0631\u062d\u0628\u0627",
    "\U0001f468\u200d\U0001f469\u200d\U0001f467 \U0001f44d\U0001f3fd \U0001f680\u2728 \U0001f1ef\U0001f1f5",
    "line one\nline two\r\nline three\rtab\there",
    "".join(chr(code) for code in range(32)) + "\x7f",
    "nul\x00inside",
    "007",
    "1e5",
    "\u2028\u2029\ufeff\ufffd",
]
LONG_NOTE = ("长文本 \U0001f4dd it's ; -- \n" * 9000) + "\x01end"  # about 230 KB: needs UPDATE appends
LONG_DESCRIPTION = "d'" * 70_000  # 140 KB of quotes that double in the literal
# An email-to-task body with CRLF line endings: hundreds of control characters in one value (a chain of char(13) ||
# char(10) operands would pass D1's expression depth limit of 100), short enough for one INSERT.
CRLF_BODY = f"{MARKER} email body line\r\n" * 600
# The same past one statement (written in hex, appended in chunks), with NUL and DEL too.
CRLF_LONG = f"{MARKER} \r\n\x00 it's\x7f\t\n" * 12_000
# Many transaction keywords wrangler's trimmer would act on (a split literal per keyword was another chain).
MARKERS_TEXT = f"{MARKER} " + "COMMIT; BEGIN TRANSACTION; " * 400
# Reals whose text rendering differs between SQLite builds, decimals some SQLite builds parse one unit off
# (-1e-300, -2.5e-308 in 3.51), the extremes, negative zero and +-Inf (D1's JSON turns Inf into null).
EDGE_REALS = [
    0.1 + 0.2,
    1 / 3,
    5e-324,
    -1e-300,
    -2.5e-308,
    1e300,
    1.7976931348623157e308,
    2.0**53 + 2,
    -0.0,
    float("inf"),
    float("-inf"),
]


def container_schema(db: sqlite3.Connection) -> None:
    """The container's DDL: migration 0001 with tasks' last three columns added by ALTER TABLE, as on the live file."""
    sql = (tool.MIGRATIONS / "0001_init.sql").read_text()
    late = "  synced_at TEXT,\n  description TEXT,\n  deleted_at TEXT,\n  deleted_source TEXT\n"
    assert late in sql
    tables, indexes = sql.replace(late, "  synced_at TEXT\n").split("CREATE INDEX", 1)
    db.executescript(tables)
    for column in ("description", "deleted_at", "deleted_source"):
        db.execute(f"ALTER TABLE tasks ADD COLUMN {column} TEXT")
    db.executescript("CREATE INDEX" + indexes)


def fill(db: sqlite3.Connection, start: int, count: int) -> None:
    """Rows `start`..`start+count-1` in every table, each value tricky in turn."""
    for n in range(start, start + count):

        def t(k: int, n: int = n) -> str:
            return f"{MARKER}-{n}-{k} " + TRICKY[(n + k) % len(TRICKY)]

        task = f"task-{n}"
        db.execute(
            "INSERT INTO tasks (id, todoist_id, title, project_name, project_color, priority, labels, estimated_mins,"
            " is_completed, completed_at, due_date, created_at, synced_at, description, deleted_at, deleted_source)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                task,
                None if n % 3 else str(9_000_000_000 + n),
                t(1),
                t(2) if n % 2 else None,
                "berry_red",
                n % 4 + 1,
                json.dumps([t(3)], ensure_ascii=False),
                None if n % 5 else 25,
                n % 2,
                None,
                "2026-10-01",
                "2026-09-30T08:00:00Z",
                None,
                t(4) if n % 4 else None,
                None,
                None,
            ),
        )
        db.execute(
            "INSERT INTO time_entries (id, task_id, flow_date, start_time, end_time, duration_s, source, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                f"te-{n}",
                task,
                "2026-10-01",
                "2026-10-01T09:00:00Z",
                None if n % 2 else "2026-10-01T09:25:00Z",
                [1500, -1, 0, 2**62, 1.5][n % 5],
                t(5),
                None,
            ),
        )
        db.execute(
            "INSERT INTO flow_tasks (id, flow_date, task_id, sort_order) VALUES (?, ?, ?, ?)",
            (f"ft-{n}", "2026-10-01", task, n),
        )
        db.execute(
            "INSERT INTO completed_flow_tasks (id, flow_date, task_id) VALUES (?, ?, ?)",
            (f"cft-{n}", "2026-09-30", task),
        )
        content = t(6) if n % 7 else bytes([0, 255, n % 256])  # a BLOB in a TEXT column stays a BLOB
        db.execute(
            "INSERT INTO flow_task_notes (id, task_id, flow_date, content, updated_at) VALUES (?, ?, ?, ?, ?)",
            (f"note-{n}", task, "2026-10-01", content, "2026-10-01 09:00:00"),
        )
        db.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (f"planning_completed:{MARKER}-{n}", t(7)))


def fill_edge_values(db: sqlite3.Connection) -> None:
    """Rows that stress the import file and verify: control-heavy and keyword-heavy text, and edge reals."""
    for n, text in enumerate((CRLF_BODY, CRLF_LONG, MARKERS_TEXT)):
        db.execute(
            "INSERT INTO tasks (id, title, description) VALUES (?, ?, ?)", (f"task-edge-{n}", f"{MARKER}-edge", text)
        )
    db.execute("INSERT INTO settings (key, value) VALUES ('crlf_value', ?)", (CRLF_BODY,))
    for n, value in enumerate(EDGE_REALS):
        db.execute(
            "INSERT INTO time_entries (id, task_id, flow_date, start_time, duration_s, source)"
            " VALUES (?, 'task-edge-0', '2026-10-01', '2026-10-01T09:00:00Z', ?, ?)",
            (f"te-edge-{n}", value, f"{MARKER}-real-{n}"),
        )


def build_container_db(directory: Path, rows: int = 40, wal_rows: int = 15, edge: bool = False) -> Path:
    """A synthetic flowday.db plus -wal copied while the writer still had commits only in its WAL.

    The writer never checkpoints (wal_autocheckpoint=0) and the files are copied before it closes, so the last
    `wal_rows` rows of each table and the long values exist only in the -wal, as on a host copied without a clean stop.
    """
    live = directory / "live"
    live.mkdir()
    writer = sqlite3.connect(live / "flowday.db")
    writer.execute("PRAGMA journal_mode = WAL")
    container_schema(writer)
    fill(writer, 0, rows)
    writer.execute("INSERT INTO settings (key, value) VALUES ('todoist_api_key', ?)", (FAKE_TODOIST_KEY,))
    writer.execute("INSERT INTO settings (key, value) VALUES ('day_capacity_mins', '480')")
    writer.execute(
        "INSERT INTO active_timer_session (id, task_id, flow_date, status, timer_mode, pomodoro_target_s,"
        " segment_wall_start, session_saved_s) VALUES ('singleton', 'task-1', '2026-10-01', 'running', 'pomodoro',"
        " 1500, '2026-10-01T09:00:00Z', 42)"
    )
    writer.commit()
    writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    writer.execute("PRAGMA wal_autocheckpoint = 0")
    fill(writer, rows, wal_rows)
    writer.execute("UPDATE flow_task_notes SET content = ? WHERE id = 'note-1'", (LONG_NOTE,))
    writer.execute("UPDATE tasks SET description = ? WHERE id = 'task-2'", (LONG_DESCRIPTION,))
    if edge:
        fill_edge_values(writer)
    writer.commit()
    copy = directory / "copy"
    copy.mkdir()
    shutil.copyfile(live / "flowday.db", copy / "flowday.db")
    shutil.copyfile(live / "flowday.db-wal", copy / "flowday.db-wal")
    writer.close()
    return copy / "flowday.db"


def tree_hashes(directory: Path) -> dict[str, str]:
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(directory.iterdir())}


def run(*argv: str) -> tuple[int, str]:
    """The tool's exit status and everything it printed."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        status = tool.main(list(argv))
    return status, out.getvalue()


class Scratch(unittest.TestCase):
    """A private temporary directory per test, outside the repository."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="flowday-migrate-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def assertNoContent(self, output: str) -> None:
        self.assertNotIn(MARKER, output)
        self.assertNotIn(FAKE_TODOIST_KEY, output)
        for text in TRICKY:
            if len(text) > 3:
                self.assertNotIn(text, output)


class LiteralTest(unittest.TestCase):
    def test_every_tricky_text_is_one_operand_that_round_trips_through_sqlite(self) -> None:
        db = sqlite3.connect(":memory:")
        for text in [*TRICKY, LONG_NOTE, CRLF_BODY, CRLF_LONG, MARKERS_TEXT]:
            with self.subTest(text=text[:20]):
                sql = tool.text_literal(text)
                self.assertNotIn("unistr", sql.lower())
                # One operand: a single quoted literal, or CAST(X'<hex>' AS TEXT); never a concatenation.
                single = sql.startswith("'") and sql.endswith("'") and "'" not in sql[1:-1].replace("''", "")
                self.assertTrue(single or re.fullmatch(r"CAST\(X'[0-9A-F]*' AS TEXT\)", sql), sql[:40])
                self.assertNotIn("BEGIN TRANSACTION", sql)
                self.assertNotIn("COMMIT;", sql)
                self.assertIsNone(tool.CONTROL.search(sql))
                (value, kind) = db.execute(f"SELECT {sql}, typeof({sql})").fetchone()
                self.assertEqual((value, kind), (text, "text"))

    def test_hundreds_of_controls_stay_within_an_expression_depth_of_100(self) -> None:
        """SQLITE_LIMIT_EXPR_DEPTH 100, as in workerd/D1: the old char(N) chain failed past about 50 CRLFs."""
        if sys.version_info < (3, 11):
            self.skipTest("sqlite3.Connection.setlimit needs Python 3.11 (the local D1 round trip covers it)")
        db = sqlite3.connect(":memory:")
        db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
        with self.assertRaises(sqlite3.OperationalError):
            db.execute("SELECT " + " || ".join(["char(13)"] * 120))  # the limit is in force
        for text in (CRLF_BODY, MARKERS_TEXT):
            self.assertEqual(db.execute(f"SELECT {tool.text_literal(text)}").fetchone()[0], text)

    def test_numbers_blobs_and_null(self) -> None:
        db = sqlite3.connect(":memory:")
        for value in (None, 0, -1, 2**62, -(2**63), 1.5, 1e300, 0.1, *EDGE_REALS, b"", b"\x00\xff"):
            with self.subTest(value=value):
                self.assertEqual(db.execute(f"SELECT {tool.literal(value)}").fetchone()[0], value)

    def test_a_long_row_becomes_an_insert_and_appends_under_the_d1_statement_limit(self) -> None:
        table = tool.source_schema()["flow_task_notes"]
        row = ("note-x", "task-x", "2026-10-01", LONG_NOTE, None)
        statements = tool.row_statements(table, table.columns, row)
        self.assertGreater(len(statements), 2)
        self.assertTrue(all(len(s.encode()) <= tool.STATEMENT_BUDGET for s in statements))
        db = sqlite3.connect(":memory:")
        db.executescript((tool.MIGRATIONS / "0001_init.sql").read_text())
        for statement in statements:
            db.execute(statement)
        self.assertEqual(db.execute("SELECT content FROM flow_task_notes").fetchone()[0], LONG_NOTE)

    def test_a_long_crlf_text_becomes_hex_appends_under_the_d1_statement_limit(self) -> None:
        table = tool.source_schema()["tasks"]
        row = ["task-x", None, "t", None, None, 1, "[]", None, 0, None, None, None, None, CRLF_LONG, None, None]
        statements = tool.row_statements(table, table.columns, row)
        self.assertGreater(len(statements), 3)
        self.assertTrue(all(len(s.encode()) <= tool.STATEMENT_BUDGET for s in statements))
        db = sqlite3.connect(":memory:")
        db.executescript((tool.MIGRATIONS / "0001_init.sql").read_text())
        for statement in statements:
            db.execute(statement)
        self.assertEqual(db.execute("SELECT description FROM tasks").fetchone()[0], CRLF_LONG)

    def test_a_long_primary_key_is_refused(self) -> None:
        table = tool.source_schema()["settings"]
        with self.assertRaises(tool.ToolError):
            tool.row_statements(table, table.columns, ("k" * 200_000, "v"))


class SchemaTest(unittest.TestCase):
    def test_the_source_is_migration_0001_and_d1_adds_one_column(self) -> None:
        source, target = tool.source_schema(), tool.target_schema()
        self.assertEqual(
            list(source),
            [
                "time_entries",
                "tasks",
                "settings",
                "flow_tasks",
                "completed_flow_tasks",
                "flow_task_notes",
                "active_timer_session",
            ],
        )
        self.assertEqual(list(target), list(source))
        self.assertEqual(target["tasks"].columns, (*source["tasks"].columns, "todoist_project_id"))
        # 0003 left tasks with its primary key and deleted_at: a task row costs three D1 rows written.
        self.assertEqual(target["tasks"].indexes, 2)
        self.assertEqual(target["settings"].indexes, 1)


class ExportTest(Scratch):
    def setUp(self) -> None:
        super().setUp()
        self.source = build_container_db(self.tmp)
        self.workdir = self.tmp / "work"

    def test_export_applies_the_wal_to_a_copy_and_never_touches_the_source(self) -> None:
        before = tree_hashes(self.source.parent)
        status, output = run("export", "--source", str(self.source), "--workdir", str(self.workdir))
        self.assertEqual(status, 0, output)
        self.assertEqual(tree_hashes(self.source.parent), before)  # byte-identical, and no -shm or new file
        self.assertNoContent(output)
        self.assertRegex(output, r"WAL: \d+ frame\(s\) in the file, [1-9]\d* applied")
        self.assertEqual(sorted(p.name for p in self.workdir.iterdir()), ["import.sql", "manifest.json", "snapshot.db"])
        for path in [self.workdir, *self.workdir.iterdir()]:
            self.assertEqual(path.stat().st_mode & 0o077, 0, path.name)
        manifest = json.loads((self.workdir / "manifest.json").read_text())
        self.assertEqual(manifest["tables"]["tasks"]["rows"], 55)
        self.assertEqual(manifest["tables"]["settings"]["rows"], 56)  # 55 synthetic + day_capacity_mins
        self.assertEqual(manifest["excluded_settings_rows"], 1)
        # The immutable main file alone misses the WAL's commits: exactly the trap the staged checkpoint avoids.
        plain = sqlite3.connect(f"file:{self.source}?mode=ro&immutable=1", uri=True)
        self.assertEqual(plain.execute("SELECT count(*) FROM tasks").fetchone()[0], 40)
        plain.close()

    def test_import_sql_names_columns_skips_the_todoist_key_and_fits_d1(self) -> None:
        self.assertEqual(run("export", "--source", str(self.source), "--workdir", str(self.workdir))[0], 0)
        sql = (self.workdir / "import.sql").read_text()
        self.assertNotIn(FAKE_TODOIST_KEY, sql)
        self.assertNotIn("todoist_api_key", sql)
        self.assertNotIn("unistr", sql.lower())
        self.assertNotIn("BEGIN TRANSACTION", sql)
        self.assertNotIn("COMMIT;", sql)
        statements = split_statements(sql)
        self.assertTrue(any(statement.startswith("UPDATE ") for statement in statements))  # the long texts
        self.assertEqual(len(statements), json.loads((self.workdir / "manifest.json").read_text())["statements"])
        for statement in statements:
            self.assertLessEqual(len(statement.encode()), tool.D1_MAX_STATEMENT_BYTES)
            self.assertRegex(
                statement, r'^(INSERT INTO "\w+" \("\w+"(, "\w+")*\) VALUES \(|UPDATE "\w+" SET "\w+" = "\w+" \|\| )'
            )
        # The file rebuilds the snapshot exactly in a fresh D1-shaped SQLite.
        db = sqlite3.connect(":memory:")
        for path in tool.migration_files():
            db.executescript(path.read_text())
        db.executescript(sql)
        snapshot = tool.open_snapshot(self.workdir / "snapshot.db")
        expected = tool.local_summaries(snapshot, tool.source_schema())
        snapshot.close()
        db.text_factory = tool.strict_text
        got = {}
        db.row_factory = sqlite3.Row
        for table in tool.source_schema().values():
            stats = dict(db.execute(tool.stats_select(table, table.columns)).fetchone())
            rows = [dict(r) for r in db.execute(tool.canonical_select(table, table.columns))]
            got[table.name] = tool.summary(table, table.columns, stats, rows)
        self.assertEqual(got, expected)

    def test_refuses_a_workdir_in_the_repository_or_next_to_the_source(self) -> None:
        for workdir in (tool.APP / "deploy" / "migrate" / "tmp-work", self.source.parent / "work"):
            with self.subTest(workdir=workdir):
                status, output = run("export", "--source", str(self.source), "--workdir", str(workdir))
                self.assertEqual(status, 2, output)
                self.assertFalse(workdir.exists())

    def test_refuses_an_unknown_table_or_column(self) -> None:
        for ddl in ("CREATE TABLE extra (id TEXT PRIMARY KEY)", "ALTER TABLE settings ADD COLUMN extra TEXT"):
            with self.subTest(ddl=ddl):
                copy = self.tmp / f"bad-{len(ddl)}"
                copy.mkdir()
                db = sqlite3.connect(copy / "flowday.db")
                container_schema(db)
                db.execute(ddl)
                db.commit()
                db.close()
                status, output = run(
                    "export",
                    "--source",
                    str(copy / "flowday.db"),
                    "--workdir",
                    str(copy.with_name(copy.name + "-work")),
                )
                self.assertEqual(status, 2, output)
                self.assertIn("differ from migration 0001", output)

    def test_refuses_invalid_utf8_and_worker_only_settings(self) -> None:
        for name, statement in (
            ("utf8", "INSERT INTO tasks (id, title) VALUES ('t', CAST(X'C328' AS TEXT))"),
            ("worker", "INSERT INTO settings (key, value) VALUES ('todoist_sync_token', 'x')"),
        ):
            with self.subTest(case=name):
                copy = self.tmp / name
                copy.mkdir()
                db = sqlite3.connect(copy / "flowday.db")
                container_schema(db)
                db.execute(statement)
                db.commit()
                db.close()
                status, output = run(
                    "export", "--source", str(copy / "flowday.db"), "--workdir", str(self.tmp / f"{name}-work")
                )
                self.assertEqual(status, 2, output)

    def test_refuses_a_wal_whose_frames_do_not_apply(self) -> None:
        """New salts in the WAL header orphan every frame (a stale or torn copy): SQLite would ignore them all."""
        wal = self.source.with_name("flowday.db-wal")
        data = bytearray(wal.read_bytes())
        data[16:24] = bytes(8)
        wal.write_bytes(bytes(data))
        status, output = run("export", "--source", str(self.source), "--workdir", str(self.workdir))
        self.assertEqual(status, 2, output)
        self.assertIn("none belong to this database", output)

    def test_refuses_a_workdir_or_source_in_a_cloud_synced_folder(self) -> None:
        home = self.tmp / "home"
        synced = home / "Library" / "CloudStorage" / "GoogleDrive-someone" / "My Drive"
        synced.mkdir(parents=True)
        shutil.copytree(self.source.parent, synced / "copy")
        with unittest.mock.patch.dict(os.environ, {"HOME": str(home)}):
            for source, workdir in (
                (self.source, synced / "flowday-work"),
                (synced / "copy" / "flowday.db", self.workdir),
                (self.source, home / "Documents" / "flowday-work"),
            ):
                with self.subTest(source=source, workdir=workdir):
                    status, output = run("export", "--source", str(source), "--workdir", str(workdir))
                    self.assertEqual(status, 2, output)
                    self.assertIn("cloud-synced folder", output)
                    self.assertFalse(workdir.exists())

    def test_refuses_a_null_primary_key(self) -> None:
        """A NULL key would slip past `key NOT IN (...)` (settings) or match no append UPDATE (a long text)."""
        for name, statement, value in (
            ("settings", "INSERT INTO settings (key, value) VALUES (NULL, ?)", f"{MARKER}-null-key"),
            ("tasks", "INSERT INTO tasks (id, title, description) VALUES (NULL, 't', ?)", LONG_DESCRIPTION),
        ):
            with self.subTest(table=name):
                copy = self.tmp / f"null-{name}"
                copy.mkdir()
                db = sqlite3.connect(copy / "flowday.db")
                container_schema(db)
                db.execute(statement, (value,))
                db.execute("INSERT INTO settings (key, value) VALUES ('day_capacity_mins', '480')")
                db.commit()
                db.close()
                status, output = run(
                    "export", "--source", str(copy / "flowday.db"), "--workdir", str(self.tmp / f"null-{name}-work")
                )
                self.assertEqual(status, 2, output)
                self.assertIn(f"table {name}: 1 row(s) with a NULL primary key", output)
                self.assertNoContent(output)
        # The filter itself keeps a NULL key, so that exclusion can never hide a row.
        db = sqlite3.connect(":memory:")
        db.executescript((tool.MIGRATIONS / "0001_init.sql").read_text())
        db.execute("INSERT INTO settings (key, value) VALUES (NULL, 'x'), ('todoist_api_key', 'k'), ('a', 'b')")
        where = tool.source_filter(tool.source_schema()["settings"])
        self.assertEqual(db.execute(f"SELECT count(*) FROM settings{where}").fetchone()[0], 2)

    def test_checks_the_copy_against_the_hashes_recorded_on_the_host(self) -> None:
        sums = self.tmp / "host.sha256"
        hashes = tree_hashes(self.source.parent)

        def export_with(source: Path, recorded: dict[str, str], name: str) -> tuple[int, str]:
            # `sha256sum /srv/.../flowday.db*` output: a path per line; only its file name counts.
            sums.write_text("".join(f"{digest}  /srv/flowday/data/{n}\n" for n, digest in recorded.items()))
            workdir = self.tmp / f"work-{name}"
            return run("export", "--source", str(source), "--workdir", str(workdir), "--expect-sha256", str(sums))

        status, output = export_with(self.source, hashes, "equal")
        self.assertEqual(status, 0, output)
        self.assertIn("Host hashes: 2 file(s) equal", output)

        status, output = export_with(self.source, {**hashes, "flowday.db": "0" * 64}, "changed")
        self.assertEqual(status, 2, output)
        self.assertIn("differs from its SHA-256 recorded on the host", output)

        status, output = export_with(self.source, {"flowday.db": hashes["flowday.db"]}, "unlisted-wal")
        self.assertEqual(status, 2, output)
        self.assertIn("a -wal missing or extra", output)

        lone = self.tmp / "lone"  # the host had a -wal, the copy has none
        lone.mkdir()
        shutil.copyfile(self.source, lone / "flowday.db")
        status, output = export_with(lone / "flowday.db", hashes, "uncopied-wal")
        self.assertEqual(status, 2, output)
        self.assertIn("a -wal missing or extra", output)

    def test_refuses_more_rows_written_than_allowed(self) -> None:
        status, output = run(
            "export", "--source", str(self.source), "--workdir", str(self.workdir), "--max-rows-written", "100"
        )
        self.assertEqual(status, 2, output)
        self.assertFalse((self.workdir / "import.sql").exists())


def split_statements(sql: str) -> list[str]:
    """Statements of an import file: a ';' ends one only outside a string literal."""
    statements, current, quoted = [], [], False
    for char in sql:
        current.append(char)
        if char == "'":
            quoted = not quoted
        elif char == ";" and not quoted:
            statements.append("".join(current).strip())
            current = []
    assert not "".join(current).strip()
    return statements


FAKE_WRANGLER = textwrap.dedent(
    '''\
    #!{python}
    """A remote D1 stand-in: a SQLite file at $FAKE_D1, answering in the shapes of wrangler's --remote --json."""
    import json, os, sqlite3, sys

    args = sys.argv[1:]
    with open(os.environ["FAKE_D1_CALLS"], "a") as calls:
        calls.write(json.dumps(args) + "\\n")
    assert "--config" in args and ("--remote" in args or args[:3] == ["d1", "time-travel", "restore"]), args
    assert "--local" not in args and "--persist-to" not in args, args
    db = sqlite3.connect(os.environ["FAKE_D1"])
    db.row_factory = sqlite3.Row
    if args[:2] == ["d1", "time-travel"]:
        tables = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'd1_migrations'")
        for (name,) in tables.fetchall():
            db.execute(f'DELETE FROM "{{name}}"')
        db.commit()
        print(json.dumps({{"bookmark": "restored"}}))
    elif "--command" in args:
        results = []
        for statement in args[args.index("--command") + 1].split("; "):
            results.append({{"results": [dict(r) for r in db.execute(statement)], "success": True, "meta": {{}}}})
        print(json.dumps(results))
    else:
        sql = open(args[args.index("--file") + 1]).read()
        before = db.total_changes
        db.executescript(sql)
        counts = {{"Total queries executed": sql.count(";\\n"), "Rows written": db.total_changes - before}}
        print(json.dumps([{{"results": [counts], "success": True}}]))
    '''
)


class FakeRemoteTest(Scratch):
    """The --remote code paths against a fake wrangler: answer shapes, Time Travel, no bookmark or row printed."""

    def setUp(self) -> None:
        super().setUp()
        self.d1 = self.tmp / "fake-d1.sqlite"
        db = sqlite3.connect(self.d1)
        for path in tool.migration_files():
            db.executescript(path.read_text())
        db.execute(
            "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)"
        )
        db.executemany("INSERT INTO d1_migrations (name) VALUES (?)", [(p.name,) for p in tool.migration_files()])
        db.commit()
        db.close()
        fake = self.tmp / "wrangler"
        fake.write_text(FAKE_WRANGLER.format(python=sys.executable))
        fake.chmod(0o700)
        self.calls = self.tmp / "calls.jsonl"
        env = {
            "FLOWDAY_WRANGLER": str(fake),
            "FAKE_D1": str(self.d1),
            "FAKE_D1_CALLS": str(self.calls),
            "FLOWDAY_D1_BOOKMARK": "00000085-0000024c-00004ff0-ba0fc8aa8fd4d6b2a68d1a2f6b8e0a7c",
        }
        for patcher in (
            unittest.mock.patch.dict(os.environ, env),
            # Small pages, so that verify reads several pages per table and several calls per run.
            unittest.mock.patch.object(tool, "PAGE_ROWS", 2),
            unittest.mock.patch.object(tool, "PAGES_PER_CALL", 3),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.source = build_container_db(self.tmp, rows=6, wal_rows=3)
        self.workdir = self.tmp / "work"
        self.assertEqual(run("export", "--source", str(self.source), "--workdir", str(self.workdir))[0], 0)
        self.estimate = json.loads((self.workdir / "manifest.json").read_text())["estimated_rows_written"]

    def test_import_verify_and_both_resets(self) -> None:
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        self.assertRegex(output, r"Imported: \d+ statement\(s\) executed, \d+ rows written")
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        self.assertNoContent(output)
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 1, output)
        self.assertIn("D1 is not empty", output)

        status, output = run("reset", "--remote", "--bookmark-env", "FLOWDAY_D1_BOOKMARK")
        self.assertEqual(status, 0, output)
        self.assertNotIn(os.environ["FLOWDAY_D1_BOOKMARK"], output)
        restore = [json.loads(line) for line in self.calls.read_text().splitlines() if "time-travel" in line]
        self.assertEqual(len(restore), 1)
        self.assertEqual(restore[0][:5], ["d1", "time-travel", "restore", "DB", "--bookmark"])
        self.assertEqual(restore[0][5], os.environ["FLOWDAY_D1_BOOKMARK"])
        self.assertIn("--json", restore[0])  # --json: no interactive confirmation

        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        status, output = run("reset", "--remote", "--delete-all-rows")
        self.assertEqual(status, 2, output)  # its write ledger lives in the work directory
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir))
        self.assertEqual(status, 0, output)
        self.assertIn("D1 is empty", output)
        ledger = json.loads((self.workdir / tool.LEDGER).read_text())
        self.assertEqual(list(ledger), [tool.utc_day()])
        self.assertGreater(ledger[tool.utc_day()], 2 * self.estimate)  # two imports and a reset

    def test_the_daily_write_budget_spans_imports_and_resets(self) -> None:
        """An import at the cap, then a reset by deletion and a retry, would pass the account's daily allowance."""
        cap = ("--max-rows-written-per-day", str(self.estimate + 10))
        status, output = run("import", "--workdir", str(self.workdir), "--remote", *cap)
        self.assertEqual(status, 0, output)
        self.assertIn(f"about 0 + {self.estimate} of {self.estimate + 10}", output)
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir), *cap)
        self.assertEqual(status, 2, output)
        self.assertIn("wait for the next UTC day", output)
        self.assertEqual(run("check-empty", "--remote")[0], 1)  # nothing was deleted
        # A Time Travel restore writes no rows through SQL: allowed, and not counted.
        self.assertEqual(run("reset", "--remote", "--bookmark-env", "FLOWDAY_D1_BOOKMARK")[0], 0)
        status, output = run("import", "--workdir", str(self.workdir), "--remote", *cap)
        self.assertEqual(status, 2, output)
        self.assertEqual(run("check-empty", "--remote")[0], 0)  # refused before any write
        with unittest.mock.patch.object(tool, "utc_day", return_value="2999-01-01"):
            status, output = run("import", "--workdir", str(self.workdir), "--remote", *cap)
        self.assertEqual(status, 0, output)

    def test_verify_reports_a_changed_row_without_printing_it(self) -> None:
        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        db = sqlite3.connect(self.d1)
        db.execute("UPDATE tasks SET title = title || 'x' WHERE id = 'task-1'")
        db.commit()
        db.close()
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 1, output)
        self.assertIn("table tasks: rows 9 / 9, column lengths DIFFERENT, sha256 DIFFERENT", output)
        self.assertNoContent(output)

    def test_verify_flags_a_leaked_todoist_key_and_a_set_d1_only_column(self) -> None:
        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        db = sqlite3.connect(self.d1)
        db.execute("UPDATE tasks SET todoist_project_id = 'p' WHERE id = 'task-1'")
        db.commit()
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 1, output)
        self.assertIn("D1-only column todoist_project_id", output)
        db.execute("UPDATE tasks SET todoist_project_id = NULL")
        db.execute("INSERT INTO settings (key, value) VALUES ('todoist_api_key', ?)", (FAKE_TODOIST_KEY,))
        db.commit()
        db.close()
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 1, output)
        self.assertIn("a todoist_api_key row exists in D1", output)
        self.assertNoContent(output)

    def test_check_empty_refuses_pending_migrations(self) -> None:
        db = sqlite3.connect(self.d1)
        db.execute("DELETE FROM d1_migrations WHERE name = ?", (tool.migration_files()[-1].name,))
        db.commit()
        db.close()
        status, output = run("check-empty", "--remote")
        self.assertEqual(status, 1, output)
        self.assertIn("applied migrations differ", output)

    def test_a_bookmark_must_look_like_one(self) -> None:
        with unittest.mock.patch.dict(os.environ, {"FLOWDAY_D1_BOOKMARK": "not a bookmark"}):
            status, output = run("reset", "--remote", "--bookmark-env", "FLOWDAY_D1_BOOKMARK")
        self.assertEqual(status, 2, output)
        self.assertNotIn("not a bookmark", output)


@unittest.skipUnless(WRANGLER.exists() or REQUIRE_WRANGLER, "wrangler is not installed in flowday/worker")
class LocalD1RoundTripTest(Scratch):
    """export -> import into a local D1 (workerd, the committed migrations) -> verify, with the pinned wrangler."""

    def setUp(self) -> None:
        super().setUp()
        self.assertTrue(WRANGLER.exists(), "run `npm ci` in flowday/worker")
        self.persist = self.tmp / "d1"
        subprocess.run(
            [
                str(WRANGLER),
                "d1",
                "migrations",
                "apply",
                "DB",
                "--local",
                "--persist-to",
                str(self.persist),
                "--config",
                str(tool.CONFIG),
            ],
            cwd=tool.WORKER,
            check=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            env=tool.wrangler_env(self.tmp),
        )
        self.local = ("--local", "--persist-to", str(self.persist))
        # Where wrangler would keep its debug log on the owner's machine: the round trip must leave nothing there.
        self.wrangler_logs = self.tmp / "wrangler-logs"
        environment = {key: value for key, value in os.environ.items() if key != "WRANGLER_WRITE_LOGS"}
        patcher = unittest.mock.patch.dict(os.environ, {**environment, "WRANGLER_LOG_PATH": str(self.wrangler_logs)})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("WRANGLER_WRITE_LOGS", None)

    def test_round_trip_is_exact_and_leaves_no_content_outside_the_workdir(self) -> None:
        source = build_container_db(self.tmp, edge=True)
        before = tree_hashes(source.parent)
        workdir = self.tmp / "work"
        printed = []
        for argv in (
            ("export", "--source", str(source), "--workdir", str(workdir)),
            ("check-empty", *self.local),
            ("import", "--workdir", str(workdir), *self.local),
            ("verify", "--workdir", str(workdir), *self.local),
        ):
            status, output = run(*argv)
            self.assertEqual(status, 0, f"{argv[0]}: {output}")
            printed.append(output)
        self.assertEqual(tree_hashes(source.parent), before)
        self.assertNoContent("".join(printed))
        self.assertIn("D1 equals the snapshot", printed[-1])
        # Not one wrangler debug log: verify's reads hold every row.
        self.assertEqual(sorted(self.wrangler_logs.rglob("*")) if self.wrangler_logs.exists() else [], [])

        # A second import into the now non-empty D1 is refused; the reset empties it again.
        status, output = run("import", "--workdir", str(workdir), *self.local)
        self.assertEqual(status, 1, output)
        status, output = run("reset", *self.local, "--delete-all-rows", "--workdir", str(workdir))
        self.assertEqual(status, 0, output)
        self.assertIn("D1 is empty", output)
        self.assertEqual(run("import", "--workdir", str(workdir), *self.local)[0], 0)
        self.assertEqual(run("verify", "--workdir", str(workdir), *self.local)[0], 0)
        self.assertFalse(self.wrangler_logs.exists())

    def test_verify_compares_identical_reals_as_equal_and_a_changed_one_as_different(self) -> None:
        """D1 renders some reals with other digits than the local SQLite: lengths skip reals, the digest is exact."""
        source = build_container_db(self.tmp, rows=2, wal_rows=1, edge=True)
        workdir = self.tmp / "work"
        for argv in (
            ("export", "--source", str(source), "--workdir", str(workdir)),
            ("import", "--workdir", str(workdir), *self.local),
            ("verify", "--workdir", str(workdir), *self.local),
        ):
            status, output = run(*argv)
            self.assertEqual(status, 0, f"{argv[0]}: {output}")
        update = "UPDATE time_entries SET duration_s = duration_s + 1e-9 WHERE id = 'te-edge-1'"
        subprocess.run(
            [str(WRANGLER), "d1", "execute", "DB", *self.local, "--config", str(tool.CONFIG), "--command", update],
            cwd=tool.WORKER,
            check=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            env=tool.wrangler_env(self.tmp),
        )
        status, output = run("verify", "--workdir", str(workdir), *self.local)
        self.assertEqual(status, 1, output)
        self.assertIn(
            f"table time_entries: rows {3 + len(EDGE_REALS)} / {3 + len(EDGE_REALS)}, column lengths equal,"
            " sha256 DIFFERENT",
            output,
        )


if __name__ == "__main__":
    unittest.main()
