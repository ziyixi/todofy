"""Tests for flowday_migrate.py with synthetic container-era databases only (never a real copy).

    python3 -m unittest discover -s flowday/deploy/migrate -p 'test_*.py'

The round trip runs the pinned wrangler against a local D1 (flowday/worker/node_modules; `npm ci` there first).
Without it those tests skip, unless FLOWDAY_MIGRATE_REQUIRE_WRANGLER=1 (CI) makes a missing wrangler a failure.
A fake wrangler backed by a plain SQLite file stands in for the remote D1 (its output shapes, Time Travel), and a
loopback server for the GraphQL Analytics API (the account's D1 rows written today). No test reaches Cloudflare.
"""

from __future__ import annotations

import contextlib
import hashlib
import http.server
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
import threading
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import flowday_migrate as tool

WRANGLER = tool.WORKER / "node_modules" / ".bin" / "wrangler"
REQUIRE_WRANGLER = os.environ.get("FLOWDAY_MIGRATE_REQUIRE_WRANGLER") == "1"
# The account of the committed config: what the usage query must ask for.
ACCOUNT = re.search(r'^account_id = "([0-9a-f]{32})"$', tool.CONFIG.read_text(), re.MULTILINE).group(1)
FAKE_API_TOKEN = "SENTINEL-api-token-never-printed-0123456789"


def setUpModule() -> None:
    """No test may reach the real GraphQL Analytics API: tests that need it patch in their loopback server."""
    patcher = unittest.mock.patch.object(tool, "GRAPHQL_URL", "http://127.0.0.1:9/unreachable")
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


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


# What wrangler 4.142's non-interactive spinner writes to stdout before the JSON of `d1 execute --remote --file
# --json` (src/d1/execute.ts: spinnerWhile around the upload; --json silences only wrangler's logger, not these).
WRANGLER_FILE_PROGRESS = (
    "├ Checking if file needs uploading\n│\n├ 🌀 Uploading 0123abcd.sql\n│ 🌀 Uploading complete.\n│\n"
)

FAKE_WRANGLER = textwrap.dedent(
    '''\
    #!@PYTHON@
    """A remote D1 stand-in: a SQLite file at $FAKE_D1, answering as wrangler 4.142 does with --remote --json.

    Every answer is pretty-printed JSON (JSON.stringify(result, null, 2)); `d1 execute --file` prints the spinner's
    progress lines first, as the real one does. Time Travel keeps a copy of the file per bookmark it hands out.
    $FAKE_FILE_ANSWER=progress-only applies a file but prints the progress lines alone (an unreadable answer).
    """
    import hashlib, json, os, shutil, sqlite3, sys

    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    with open(os.environ["FAKE_D1_CALLS"], "a") as calls:
        calls.write(json.dumps(args) + "\\n")
    assert "--config" in args and "--json" in args, args
    assert "--remote" in args or args[:2] == ["d1", "time-travel"], args
    assert "--local" not in args and "--persist-to" not in args, args
    path = os.environ["FAKE_D1"]


    def empty_tables():
        db = sqlite3.connect(path)
        names = db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'd1_migrations'")
        for (name,) in names.fetchall():
            db.execute(f'DELETE FROM "{name}"')
        db.commit()
        db.close()


    if args[:3] == ["d1", "time-travel", "info"]:
        with open(path, "rb") as handle:
            bookmark = "0000002a-00000001-00004ff0-" + hashlib.sha256(handle.read()).hexdigest()[:32]
        shutil.copyfile(path, f"{path}.{bookmark}")
        print(json.dumps({"bookmark": bookmark, "timestamp": "2026-10-01T12:00:00.000Z"}, indent=2))
    elif args[:3] == ["d1", "time-travel", "restore"]:
        bookmark = args[args.index("--bookmark") + 1]
        if os.path.exists(f"{path}.{bookmark}"):
            shutil.copyfile(f"{path}.{bookmark}", path)
        else:  # a bookmark from before this fake's first info: D1 as the migrations left it
            empty_tables()
        print(json.dumps({"success": True, "bookmark": bookmark}, indent=2))
    elif "--command" in args:
        db = sqlite3.connect(path)
        db.row_factory = sqlite3.Row
        results = []
        for statement in args[args.index("--command") + 1].split("; "):
            results.append({"results": [dict(r) for r in db.execute(statement)], "success": True, "meta": {}})
        print(json.dumps(results, indent=2))
    else:
        db = sqlite3.connect(path)
        sql = open(args[args.index("--file") + 1]).read()
        before = db.total_changes
        db.executescript(sql)
        written = db.total_changes - before
        db.close()
        sys.stdout.write(os.environ["FAKE_FILE_PROGRESS"])
        if os.environ.get("FAKE_FILE_ANSWER") != "progress-only":
            counts = {
                "Total queries executed": sql.count(";\\n"),
                "Rows read": 0,
                "Rows written": written,
                "Database size (MB)": "0.10",
            }
            meta = {"rows_read": 0, "rows_written": written, "duration": 1.5}
            answer = [{"results": [counts], "success": True, "finalBookmark": "0000002a-00000002", "meta": meta}]
            print(json.dumps(answer, indent=2))
    '''
)


class FakeGraphQL:
    """A loopback GraphQL Analytics API answering the D1 usage query with `rows_written`, one group per database."""

    def __init__(self) -> None:
        self.rows_written = [0]
        self.status = 200
        self.errors: list | None = None
        self.requests: list[dict] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fake.requests.append({"auth": self.headers.get("Authorization"), "body": body})
                groups = [
                    {"sum": {"rowsWritten": n}, "dimensions": {"databaseId": f"database-{i}"}}
                    for i, n in enumerate(fake.rows_written)
                ]
                answer = {"data": {"viewer": {"accounts": [{"d1AnalyticsAdaptiveGroups": groups}]}}}
                if fake.errors is not None:
                    answer = {"data": None, "errors": fake.errors}
                data = json.dumps(answer).encode()
                self.send_response(fake.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/client/v4/graphql"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class JsonAnswerTest(unittest.TestCase):
    def test_reads_the_document_after_wranglers_progress_lines(self) -> None:
        document = [{"results": [{"Total queries executed": 3, "Rows written": 9}], "success": True}]
        for name, output in (
            ("plain", json.dumps(document)),
            ("pretty", json.dumps(document, indent=2) + "\n"),
            ("progress", WRANGLER_FILE_PROGRESS + json.dumps(document, indent=2) + "\n"),
            ("coloured", "\x1b[90m│\x1b[39m\n\x1b[90m├\x1b[39m Uploading\n" + json.dumps(document, indent=2)),
            ("object", "warning text\n" + json.dumps({"bookmark": "00000085-0000024c"}, indent=2)),
        ):
            with self.subTest(case=name):
                expected = document if name != "object" else {"bookmark": "00000085-0000024c"}
                self.assertEqual(tool.json_answer(output), expected)

    def test_anything_else_is_unreadable(self) -> None:
        for output in (
            "",
            WRANGLER_FILE_PROGRESS,
            "🚣 Executed 3 queries",
            json.dumps([{"a": 1}]) + "\ntrailing text",
            '[{"truncated": ',
        ):
            with self.subTest(output=output[:20]):
                self.assertIsNone(tool.json_answer(output))


class KeysetTest(unittest.TestCase):
    def test_pages_are_primary_key_range_searches_without_offset(self) -> None:
        """WHERE pk > :last ORDER BY pk LIMIT n: SQLite searches the key's index; no scan, sort or OFFSET."""
        db = sqlite3.connect(":memory:")
        for path in tool.migration_files():
            db.executescript(path.read_text())
        for table in tool.source_schema().values():
            with self.subTest(table=table.name):
                first = tool.keyset_select(table, None)
                # A key holding a quote, a statement end and a comment marker: the literal holds none of them.
                row = {f"t{i}": "text" for i in range(len(table.columns))}
                row.update({f"v{i}": "k'; --" for i in range(len(table.columns))})
                after = tool.key_after(table, row)
                self.assertNotIn(";", after)
                self.assertNotIn("'; --", after)
                page = tool.keyset_select(table, after)
                for statement in (first, page):
                    self.assertNotIn("OFFSET", statement.upper())
                    self.assertTrue(statement.endswith(f" LIMIT {tool.PAGE_ROWS}"))
                    self.assertRegex(statement, tool.READ_ONLY)
                plan = " ".join(str(step[-1]) for step in db.execute("EXPLAIN QUERY PLAN " + page))
                pattern = rf"SEARCH (TABLE )?{table.name} USING (COVERING )?INDEX \S+ \({table.primary_key}>\?\)"
                self.assertRegex(plan, pattern)
                self.assertNotIn("TEMP B-TREE", plan)
                self.assertEqual(db.execute(page).fetchall(), [])

    def test_a_key_of_another_type_continues_exactly_after_it(self) -> None:
        table = tool.source_schema()["settings"]
        self.assertEqual(tool.key_after(table, {"t0": "blob", "v0": "00FF", "t1": "null", "v1": None}), "X'00FF'")
        self.assertEqual(tool.key_after(table, {"t0": "integer", "v0": "-12", "t1": "null", "v1": None}), "-12")
        with self.assertRaises(tool.ToolError):
            tool.key_after(table, {"t0": "null", "v0": None, "t1": "null", "v1": None})


class FakeRemoteTest(Scratch):
    """The --remote code paths against a fake wrangler and a fake GraphQL API: answer shapes, Time Travel, the
    account's daily budget, and that no bookmark, token, row or wrangler text is printed."""

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
        fake.write_text(FAKE_WRANGLER.replace("@PYTHON@", sys.executable))
        fake.chmod(0o700)
        self.calls = self.tmp / "calls.jsonl"
        self.graphql = FakeGraphQL()
        self.addCleanup(self.graphql.close)
        env = {
            "FLOWDAY_WRANGLER": str(fake),
            "FAKE_D1": str(self.d1),
            "FAKE_D1_CALLS": str(self.calls),
            "FAKE_FILE_PROGRESS": WRANGLER_FILE_PROGRESS,
            "FLOWDAY_D1_BOOKMARK": "00000085-0000024c-00004ff0-ba0fc8aa8fd4d6b2a68d1a2f6b8e0a7c",
            "CLOUDFLARE_API_TOKEN": FAKE_API_TOKEN,
            "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
        for patcher in (
            unittest.mock.patch.dict(os.environ, env),
            unittest.mock.patch.object(tool, "GRAPHQL_URL", self.graphql.url),
            # Small pages, so that verify reads several pages per table and several calls per run.
            unittest.mock.patch.object(tool, "PAGE_ROWS", 2),
            unittest.mock.patch.object(tool, "PAGES_PER_CALL", 3),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.source = build_container_db(self.tmp, rows=6, wal_rows=3)
        self.workdir = self.tmp / "work"
        self.assertEqual(run("export", "--source", str(self.source), "--workdir", str(self.workdir))[0], 0)
        self.manifest = json.loads((self.workdir / "manifest.json").read_text())
        self.estimate = self.manifest["estimated_rows_written"]
        # What deleting the imported rows costs: each row and its index entries.
        target = tool.target_schema()
        self.reset_estimate = sum(
            entry["rows"] * (1 + target[name].indexes) for name, entry in self.manifest["tables"].items()
        )

    def assertQuiet(self, output: str) -> None:
        """Nothing printed is a row, a bookmark, the token or wrangler's own text."""
        self.assertNoContent(output)
        self.assertNotIn(FAKE_API_TOKEN, output)
        self.assertNotIn(os.environ["FLOWDAY_D1_BOOKMARK"], output)
        self.assertNotRegex(output, r"0000002a-0000000[12]")
        for text in ("Uploading", "Checking if file", "├", "│", "finalBookmark"):
            self.assertNotIn(text, output)

    def wrangler_calls(self) -> list[list[str]]:
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def count(self, table: str) -> int:
        db = sqlite3.connect(self.d1)
        try:
            return db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        finally:
            db.close()

    def test_import_verify_and_both_resets(self) -> None:
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        self.assertRegex(output, r"Imported: \d+ statement\(s\) executed, \d+ rows written")
        self.assertQuiet(output)
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        self.assertQuiet(output)
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 1, output)
        self.assertIn("D1 is not empty", output)

        status, output = run("reset", "--remote", "--bookmark-env", "FLOWDAY_D1_BOOKMARK")
        self.assertEqual(status, 0, output)
        self.assertQuiet(output)
        restore = [call for call in self.wrangler_calls() if call[:3] == ["d1", "time-travel", "restore"]]
        self.assertEqual(len(restore), 1)
        self.assertEqual(restore[0][:5], ["d1", "time-travel", "restore", "DB", "--bookmark"])
        self.assertEqual(restore[0][5], os.environ["FLOWDAY_D1_BOOKMARK"])
        self.assertIn("--json", restore[0])  # --json: no interactive confirmation

        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        status, output = run("reset", "--remote", "--delete-all-rows")
        self.assertEqual(status, 2, output)  # its manifest, write ledger and bookmark live in the work directory
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir))
        self.assertEqual(status, 0, output)
        self.assertIn("D1 is empty", output)
        self.assertQuiet(output)
        ledger = json.loads((self.workdir / tool.LEDGER).read_text())
        self.assertEqual(list(ledger), [tool.utc_day()])
        self.assertEqual(ledger[tool.utc_day()], 2 * self.estimate + self.reset_estimate)  # two imports, a reset

    def test_import_reads_wranglers_answer_behind_its_progress_lines(self) -> None:
        """The production bug: `d1 execute --remote --file --json` prints spinner lines before the JSON."""
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        self.assertNotIn("did not answer", output)
        counts = re.search(r"Imported: (\d+) statement\(s\) executed, (\d+) rows written", output)
        statements, written = map(int, counts.groups())
        self.assertEqual(statements, self.manifest["statements"])
        self.assertGreater(written, 0)
        self.assertQuiet(output)
        # wrangler's own text stays in the private log.
        log = self.workdir / "wrangler-import.log"
        self.assertIn("Uploading complete", log.read_text())
        self.assertEqual(log.stat().st_mode & 0o077, 0)
        # The empty D1's bookmark was saved before the import; only the file's path is printed.
        [saved] = sorted(self.workdir.glob("d1-bookmark-import-*.json"))
        self.assertIn(str(saved), output)
        self.assertEqual(saved.stat().st_mode & 0o077, 0)
        self.assertNotIn(json.loads(saved.read_text())["bookmark"], output)
        calls = self.wrangler_calls()
        info = calls.index(next(call for call in calls if call[:3] == ["d1", "time-travel", "info"]))
        self.assertLess(info, calls.index(next(call for call in calls if "--file" in call)))
        # Restoring that bookmark empties D1 again, and verify after a second import still passes.
        status, output = run("reset", "--remote", "--bookmark-file", str(saved))
        self.assertEqual(status, 0, output)
        self.assertIn("D1 is empty", output)
        self.assertQuiet(output)

    def test_an_unreadable_answer_asks_for_verify_not_a_second_import(self) -> None:
        with unittest.mock.patch.dict(os.environ, {"FAKE_FILE_ANSWER": "progress-only"}):
            status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 3, output)
        self.assertIn("UNCONFIRMED: wrangler exited 0 after the import, but its answer could not be read", output)
        self.assertIn("run verify next, not import", output)
        self.assertQuiet(output)
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)  # it had imported
        # Unreadable after a reset by deletion: check-empty next.
        with unittest.mock.patch.dict(os.environ, {"FAKE_FILE_ANSWER": "progress-only"}):
            status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir))
        self.assertEqual(status, 3, output)
        self.assertIn("run check-empty next", output)
        self.assertEqual(run("check-empty", "--remote")[0], 0)

    def test_the_daily_write_budget_spans_imports_and_resets(self) -> None:
        """An import at the cap, then a reset by deletion and a retry, would pass the account's daily allowance."""
        cap = ("--max-rows-written-per-day", str(self.estimate + 10))
        status, output = run("import", "--workdir", str(self.workdir), "--remote", *cap)
        self.assertEqual(status, 0, output)
        self.assertIn(f"about 0 + {self.estimate} of {self.estimate + 10}", output)
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir), *cap)
        self.assertEqual(status, 2, output)
        self.assertIn("retry after 00:00 UTC", output)
        self.assertEqual(run("check-empty", "--remote")[0], 1)  # nothing was deleted
        # A Time Travel restore writes no rows through SQL: allowed, and not counted.
        self.assertEqual(run("reset", "--remote", "--bookmark-env", "FLOWDAY_D1_BOOKMARK")[0], 0)
        status, output = run("import", "--workdir", str(self.workdir), "--remote", *cap)
        self.assertEqual(status, 2, output)
        self.assertEqual(run("check-empty", "--remote")[0], 0)  # refused before any write
        with unittest.mock.patch.object(tool, "utc_day", return_value="2999-01-01"):
            status, output = run("import", "--workdir", str(self.workdir), "--remote", *cap)
        self.assertEqual(status, 0, output)

    def test_the_accounts_rows_written_today_count_against_the_budget(self) -> None:
        """Other apps' writes today (and those of another work directory) count: the import refuses above 80k."""
        limit = tool.DEFAULT_MAX_ACCOUNT_ROWS_WRITTEN
        self.graphql.rows_written = [70_000, limit - 70_000 - self.estimate + 1]
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 2, output)
        self.assertIn(f"the account wrote about {limit - self.estimate + 1} today (UTC)", output)
        self.assertIn("retry after 00:00 UTC", output)
        self.assertQuiet(output)
        self.assertEqual(run("check-empty", "--remote")[0], 0)  # refused before any write
        self.assertFalse((self.workdir / tool.LEDGER).exists())
        self.assertFalse(list(self.workdir.glob("d1-bookmark-*")))
        # The request: the token as a bearer only, the committed account, today (UTC), D1's rows written.
        request = self.graphql.requests[-1]
        self.assertEqual(request["auth"], f"Bearer {FAKE_API_TOKEN}")
        self.assertEqual(request["body"]["variables"], {"a": ACCOUNT, "day": tool.utc_day()})
        self.assertIn("d1AnalyticsAdaptiveGroups", request["body"]["query"])
        self.assertIn("rowsWritten", request["body"]["query"])
        # At exactly the cap it passes.
        self.graphql.rows_written = [70_000, limit - 70_000 - self.estimate]
        status, output = run("import", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        self.assertIn(f"by the account: about {limit - self.estimate} + {self.estimate} of {limit}", output)
        # Without CLOUDFLARE_ACCOUNT_ID the config's account is asked for.
        os.environ.pop("CLOUDFLARE_ACCOUNT_ID")
        self.assertEqual(tool.account_id(), ACCOUNT)

    def test_a_reset_by_deletion_has_its_own_estimate(self) -> None:
        """Deleting costs each row and its index entries, from D1's counts (not the import file's estimate)."""
        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        self.assertNotEqual(self.reset_estimate, self.estimate)  # the import also appends long texts
        limit = tool.DEFAULT_MAX_ACCOUNT_ROWS_WRITTEN
        self.graphql.rows_written = [limit - self.reset_estimate + 1]
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir))
        self.assertEqual(status, 2, output)
        self.assertIn(f"the reset would write about {self.reset_estimate} D1 rows", output)
        self.assertEqual(self.count("tasks"), 9)
        self.graphql.rows_written = [limit - self.reset_estimate]
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir))
        self.assertEqual(status, 0, output)
        self.assertIn(f"+ {self.reset_estimate} of {limit}", output)

    def test_the_budget_check_needs_the_analytics_api_and_fails_closed(self) -> None:
        for name, change, message in (
            ("no token", {"CLOUDFLARE_API_TOKEN": ""}, "CLOUDFLARE_API_TOKEN is unset"),
            ("other account", {"CLOUDFLARE_ACCOUNT_ID": "f" * 32}, "not the account of flowday/wrangler.toml"),
            ("bad account", {"CLOUDFLARE_ACCOUNT_ID": "x"}, "not a 32-character account id"),
            ("http", {}, "the GraphQL Analytics API answered HTTP 403"),
            ("graphql", {}, "does the token have Account Analytics Read?"),
            ("truncated", {}, "does the token have Account Analytics Read?"),
        ):
            with self.subTest(case=name):
                self.graphql.status = 403 if name == "http" else 200
                self.graphql.errors = [{"message": "SENTINEL error body"}] if name == "graphql" else None
                self.graphql.rows_written = [1] * (tool.GRAPHQL_GROUPS if name == "truncated" else 1)
                with unittest.mock.patch.dict(os.environ, change):
                    status, output = run("import", "--workdir", str(self.workdir), "--remote")
                self.assertEqual(status, 2, output)
                self.assertIn(message, output)
                self.assertNotIn("SENTINEL error body", output)
                self.assertQuiet(output)
                self.assertEqual(self.count("tasks"), 0)

    def test_verify_pages_each_table_by_its_primary_key(self) -> None:
        """Keyset pages: no OFFSET, and every page after a table's first continues after the last key read."""
        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        self.calls.unlink()
        status, output = run("verify", "--workdir", str(self.workdir), "--remote")
        self.assertEqual(status, 0, output)
        statements = [
            statement for call in self.wrangler_calls() for statement in call[call.index("--command") + 1].split("; ")
        ]
        self.assertFalse([s for s in statements if "OFFSET" in s.upper()])
        for table in tool.source_schema().values():
            with self.subTest(table=table.name):
                pages = [s for s in statements if s.startswith("SELECT typeof(") and f'FROM "{table.name}"' in s]
                rows = self.manifest["tables"][table.name]["rows"]
                self.assertEqual(len(pages), rows // 2 + 1 if rows else 0)  # each row once, then a short page
                for page in pages[1:]:
                    self.assertRegex(page, rf'WHERE "{table.primary_key}" > CAST\(X\'[0-9A-F]+\' AS TEXT\) ORDER BY')
                for page in pages:
                    self.assertTrue(page.endswith(" LIMIT 2"))

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

    def test_a_reset_by_deletion_never_deletes_what_was_written_after_the_import(self) -> None:
        """After the cutover D1 is production: more rows than imported, or rows only the Worker writes, refuse."""
        self.assertEqual(run("import", "--workdir", str(self.workdir), "--remote")[0], 0)
        reset = ("reset", "--remote", "--delete-all-rows", "--workdir", str(self.workdir))
        for name, statement in (
            ("a new row", "INSERT INTO flow_tasks (id, flow_date, task_id, sort_order) VALUES ('new', 'd', 't', 0)"),
            ("a sync setting", "UPDATE settings SET key = 'todoist_sync_token' WHERE key = 'day_capacity_mins'"),
            ("a synced task", "UPDATE tasks SET todoist_project_id = 'p' WHERE id = 'task-1'"),
        ):
            with self.subTest(case=name):
                snapshot = self.tmp / "before.sqlite"
                shutil.copyfile(self.d1, snapshot)
                db = sqlite3.connect(self.d1)
                db.execute(statement)
                db.commit()
                db.close()
                status, output = run(*reset)
                self.assertEqual(status, 1, output)
                self.assertIn("--confirm-database flowday", output)
                self.assertEqual(self.count("tasks"), 9)  # nothing deleted
                self.assertFalse(list(self.workdir.glob("d1-bookmark-reset-*")))
                self.assertQuiet(output)
                shutil.copyfile(snapshot, self.d1)
        # A work directory without a manifest has nothing to compare with.
        bare = self.tmp / "bare"
        bare.mkdir(mode=0o700)
        status, output = run("reset", "--remote", "--delete-all-rows", "--workdir", str(bare))
        self.assertEqual(status, 1, output)
        self.assertIn("no manifest.json", output)
        # Only the database's exact name overrides the check.
        db = sqlite3.connect(self.d1)
        db.execute("INSERT INTO settings (key, value) VALUES ('todoist_sync_token', 'x')")
        db.commit()
        db.close()
        for wrong in ("yes", "DB", "flowday-next"):
            status, output = run(*reset, "--confirm-database", wrong)
            self.assertEqual(status, 2, output)
        restore = ("reset", "--remote", "--bookmark-env", "FLOWDAY_D1_BOOKMARK", "--confirm-database", "flowday")
        self.assertEqual(run(*restore)[0], 2)
        status, output = run(*reset, "--confirm-database", "flowday")
        self.assertEqual(status, 0, output)
        self.assertIn("deleting although", output)
        self.assertIn("D1 is empty", output)
        # The bookmark from before the deletion was saved first; restoring it brings the rows back.
        [saved] = sorted(self.workdir.glob("d1-bookmark-reset-*.json"))
        self.assertIn(str(saved), output)
        status, output = run("reset", "--remote", "--bookmark-file", str(saved))
        self.assertEqual(status, 0, output)
        self.assertIn("table tasks: 9 row(s)", output)
        self.assertNotIn("D1 is empty", output)
        self.assertQuiet(output)
        self.assertEqual(self.count("tasks"), 9)
        self.assertEqual(self.count("settings"), self.manifest["tables"]["settings"]["rows"] + 1)

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
        bad = self.workdir / "d1-bookmark-bad.json"
        bad.write_text('{"bookmark": "not a bookmark"}')
        status, output = run("reset", "--remote", "--bookmark-file", str(bad))
        self.assertEqual(status, 2, output)
        self.assertNotIn("not a bookmark", output)
        self.assertFalse([call for call in self.wrangler_calls() if call[:3] == ["d1", "time-travel", "restore"]])


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
