"""Host tests for the legacy export and its verifier, on synthetic SQLite only."""

import hashlib
import json
import os
import re
import sqlite3
import stat
from pathlib import Path

import legacy_to_d1 as export_tool
import pytest
import verify_d1
from fixtures import synthetic
from legacy_to_d1 import LEDGER, LEGACY_TEXT, MAX_STATEMENT_BYTES, SUMMARIES, TABLES

from todofy.core import render
from todofy.core.vocab import TERMINAL_STATES, EventState, ReminderState

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations" / "0001_init.sql"
# The protos checkout next to the monorepo checkout (todofy/ is one level below the repository root),
# or next to a standalone todofy checkout; TODOFY_PROTOS_DIR overrides both. Absent: the check skips.
_PROTOS_CANDIDATES = (ROOT.parent.parent / "protos", ROOT.parent / "protos")
PROTOS = (
    Path(os.environ["TODOFY_PROTOS_DIR"])
    if os.environ.get("TODOFY_PROTOS_DIR")
    else next((path for path in _PROTOS_CANDIDATES if path.exists()), _PROTOS_CANDIDATES[0])
)


@pytest.fixture
def sources(tmp_path: Path) -> tuple[Path, Path, dict]:
    facts = synthetic.build(tmp_path)
    return tmp_path / "inbox.sqlite", tmp_path / "todofy.db", facts


def run_export(inbox: Path, legacy: Path, out: Path, *extra: str) -> dict:
    code = export_tool.main(["--inbox", str(inbox), "--legacy", str(legacy), "--out", str(out), *extra])
    assert code == 0
    return json.loads((out / "manifest.json").read_text())


def d1_like(tmp_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(tmp_path / "d1.sqlite")
    db.executescript(MIGRATION.read_text())
    return db


def apply(db: sqlite3.Connection, out: Path, manifest: dict) -> None:
    for name in sorted(manifest["files"]):
        db.executescript((out / name).read_text(encoding="utf-8"))


def sqlite_query(db: sqlite3.Connection) -> verify_d1.Query:
    def run(sql: str) -> list[dict]:
        cursor = db.execute(sql)
        names = [column[0] for column in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor]

    return run


# ---------------------------------------------------------------- frozen vocabulary


def test_subject_label_is_the_render_constant() -> None:
    assert render.SUBJECT_LABEL == export_tool.SUBJECT_LABEL


def test_states_match_the_worker_vocabulary() -> None:
    assert {state.value for state in EventState} == export_tool.EVENT_STATES
    assert {state.value for state in TERMINAL_STATES} == export_tool.TERMINAL_STATES
    assert {state.value for state in ReminderState} == export_tool.REMINDER_STATES


def derive_model_name(enum_name: str) -> str:
    tokens = enum_name.removeprefix("MODEL_").lower().split("_")
    if tokens == ["unspecified"]:
        return "unspecified"
    version, rest = tokens[1], tokens[2:]
    if rest and len(rest[0]) == 1 and rest[0].isdigit():
        version, rest = f"{version}.{rest[0]}", rest[1:]
    return "-".join([tokens[0], version, *rest])


def test_model_table_covers_the_enum_and_derives_names() -> None:
    assert sorted(export_tool.MODELS) == list(range(19))
    for enum_name, name in export_tool.MODELS.values():
        assert name == derive_model_name(enum_name)
    assert export_tool.model_name(12) == "gemini-3.8-flash"
    assert export_tool.model_name(99) == "legacy-model-99"
    assert export_tool.model_name(None) == "legacy-model-None"


@pytest.mark.skipif(not (PROTOS / "proto/todofy/large_language_model.proto").exists(), reason="protos repo absent")
def test_model_table_matches_the_proto() -> None:
    source = (PROTOS / "proto/todofy/large_language_model.proto").read_text()
    body = source.split("enum Model {", 1)[1].split("}", 1)[0]
    numbers = {int(number): name for name, number in re.findall(r"^\s*(MODEL_\w+) = (\d+)", body, re.M)}
    assert numbers == {number: enum_name for number, (enum_name, _) in export_tool.MODELS.items()}
    comments = re.findall(r"//\s*(gemini-[\w.-]+).*\n\s*(MODEL_\w+) =", body)
    assert comments and all(export_tool.MODELS[_number(name)][1] == comment for comment, name in comments)


def _number(enum_name: str) -> int:
    return next(number for number, (name, _) in export_tool.MODELS.items() if name == enum_name)


# ---------------------------------------------------------------- parsing and SQL


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-09-23 16:00:00+00:00", (1790179200, 0)),
        ("2026-09-23 09:00:00.123456789-07:00", (1790179200, 123456789)),
        ("2026-09-23T16:00:00.5Z", (1790179200, 500000000)),
        ("2026-09-23 16:00:00", (1790179200, 0)),
        ("2026-09-24 00:00:00+0800", (1790179200, 0)),
        (1790179200, (1790179200, 0)),
    ],
)
def test_gorm_time(raw: object, expected: tuple[int, int]) -> None:
    assert export_tool.gorm_time(raw) == expected


@pytest.mark.parametrize("raw", ["", "2026-09-23", "yesterday", None, 1.5])
def test_gorm_time_rejects_garbage(raw: object) -> None:
    with pytest.raises(ValueError):
        export_tool.gorm_time(raw)


def test_parse_subject_unescapes_the_html_template_output() -> None:
    body = synthetic.todo_body(synthetic.ESCAPED_SUBJECT, "text **SUBJECT: not this**")
    assert export_tool.parse_subject(body) == synthetic.UNESCAPED_SUBJECT
    assert export_tool.parse_subject("no header") == ""


def test_sql_literal() -> None:
    assert export_tool.sql_literal(None) == "NULL"
    assert export_tool.sql_literal(7) == "7"
    assert export_tool.sql_literal("it's") == "'it''s'"
    assert export_tool.sql_literal("a\x00'") == "CAST(X'610027' AS TEXT)"
    with pytest.raises(TypeError):
        export_tool.sql_literal(True)


def test_long_values_are_chunked_and_reruns_are_idempotent(tmp_path: Path) -> None:
    db = d1_like(tmp_path)
    value = synthetic.long_text() + "''''" * 30_000
    row = ("legacy:x", 1, value, None)
    statements = export_tool.row_statements(LEGACY_TEXT, row)
    assert len(statements) > 3
    assert all(len(statement.encode()) <= MAX_STATEMENT_BYTES for statement in statements)
    # A run interrupted halfway, then two full runs.
    for statement in statements[: len(statements) // 2]:
        db.execute(statement)
    for _ in range(2):
        for statement in statements:
            db.execute(statement)
    assert db.execute("SELECT text FROM legacy_mail_text").fetchone()[0] == value


def test_short_columns_never_chunk() -> None:
    row = ("mail-hero-personal", "x" * 100_000, *([0] * 16))
    with pytest.raises(export_tool.ExportError):
        export_tool.row_statements(LEDGER, row)


# ---------------------------------------------------------------- whole export


def test_export_matches_the_synthetic_sources(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, facts = sources
    manifest = run_export(inbox, legacy, tmp_path / "out")
    tables = manifest["tables"]
    assert tables["mail_events"]["rows"] == facts["ledger_rows"]
    assert tables["mail_reminders"]["rows"] == facts["reminder_rows"]
    # CloudMailin-era rows are part of the default export (the owner migrates the whole cache).
    assert tables["summaries"]["rows"] == facts["mailhero_summaries"] + facts["cloudmailin_summaries"]
    assert tables["legacy_mail_text"]["rows"] == facts["texts_mailhero"] + facts["texts_cloudmailin"]
    assert manifest["state_counts"] == facts["state_counts"]
    assert manifest["options"] == {"include_text": True, "include_cloudmailin": True}
    assert manifest["stats"]["cloudmailin_entries"] == facts["cloudmailin_summaries"]
    assert "cloudmailin_skipped" not in manifest["stats"]
    assert manifest["stats"]["entries_soft_deleted"] == 1
    assert manifest["stats"]["entries_duplicate_dropped"] == 2
    assert manifest["stats"]["summaries_without_subject"] == 2
    assert {w["code"] for w in manifest["warnings"]} == {"text_chunked", "mailhero_entry_unlinked"}
    chunked = [w["detail"] for w in manifest["warnings"] if w["code"] == "text_chunked"]
    assert chunked == [synthetic.event_id(synthetic.LONG_TEXT_EVENT)]
    for name, info in manifest["files"].items():
        path = tmp_path / "out" / name
        assert info["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        statements = [s for s in path.read_text().split(";\n") if s.strip() and not s.startswith("--")]
        assert all(len(s.encode()) < MAX_STATEMENT_BYTES for s in statements)
    assert "BEGIN" not in (tmp_path / "out" / "01-ledger.sql").read_text()


def test_exported_rows(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    manifest = run_export(inbox, legacy, tmp_path / "out")
    db = d1_like(tmp_path)
    apply(db, tmp_path / "out", manifest)
    db.row_factory = sqlite3.Row
    first = synthetic.event_id(0)
    summary = db.execute("SELECT * FROM summaries WHERE event_id = ?", (first,)).fetchone()
    assert summary["subject"] == synthetic.UNESCAPED_SUBJECT  # newest duplicate, unescaped
    assert summary["task_id"] == "9000000000"
    assert summary["model"] == "gemini-2.5-pro"
    assert summary["created_at"] == synthetic.BASE + 60
    assert summary["imported"] == 1
    moments = {
        row["event_id"]: row["created_at"]
        for row in db.execute(
            "SELECT event_id, created_at FROM summaries WHERE event_id IN (?, ?)",
            (synthetic.event_id(4), synthetic.event_id(1)),
        )
    }
    assert moments == {
        synthetic.event_id(4): synthetic.BASE + 4 * 3600 + 60,
        synthetic.event_id(1): synthetic.BASE + 3600 + 60,
    }
    models = dict(
        db.execute(
            "SELECT event_id, model FROM summaries WHERE event_id IN (?, ?)",
            (synthetic.event_id(3), synthetic.event_id(4)),
        ).fetchall()
    )
    assert models == {synthetic.event_id(3): "unspecified", synthetic.event_id(4): "legacy-model-99"}
    orphan = db.execute(
        "SELECT * FROM summaries WHERE event_id = ?", ("legacy:" + synthetic.mailhero_hash(synthetic.event_id(1000)),)
    ).fetchone()
    assert orphan["task_id"] == ""
    ledger = db.execute("SELECT * FROM mail_events WHERE event_id = ?", (first,)).fetchone()
    assert dict(ledger) | {"payload_hash": None} == {
        "source_id": "mail-hero-personal",
        "event_id": first,
        "payload_hash": None,
        "payload": None,
        "state": "complete",
        "version": 1,
        "summary": "",
        "summary_model": "",
        "todo_body": "",
        "todoist_request_id": "",
        "task_id": "9000000000",
        "attempt_count": 1,
        "crashes": 0,
        "next_attempt_at": 0,
        "last_error_code": "",
        "imported": 1,
        "created_at": synthetic.BASE,
        "updated_at": synthetic.BASE + 120,
    }
    assert ledger["payload_hash"] == hashlib.sha256(b"payload-0").hexdigest()
    long_text = db.execute(
        "SELECT text, expires_at FROM legacy_mail_text WHERE event_id = ?",
        (synthetic.event_id(synthetic.LONG_TEXT_EVENT),),
    ).fetchone()
    assert tuple(long_text) == (synthetic.long_text(), None)
    reminder = db.execute("SELECT * FROM mail_reminders WHERE day = '2026-09-21'").fetchone()
    assert (reminder["state"], reminder["subject"], reminder["body"], reminder["imported"]) == (
        "unknown",
        "subject 2026-09-21",
        "body",
        1,
    )
    # A same-day failed reminder is retried by the Worker with its frozen text, so it must come along.
    failed = db.execute("SELECT * FROM mail_reminders WHERE day = '2026-09-22'").fetchone()
    assert (failed["subject"], failed["body"], failed["next_attempt_at"]) == (
        "subject 2026-09-22",
        "body",
        synthetic.BASE + 3600,
    )


def test_cloudmailin_rows_can_be_skipped_with_a_warning(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, facts = sources
    manifest = run_export(inbox, legacy, tmp_path / "out", "--skip-cloudmailin")
    assert manifest["options"]["include_cloudmailin"] is False
    assert manifest["tables"]["summaries"]["rows"] == facts["mailhero_summaries"]
    assert manifest["stats"]["cloudmailin_skipped"] == facts["cloudmailin_summaries"]
    assert {"code": "cloudmailin_skipped", "detail": "7 cache rows"} in manifest["warnings"]


def test_cloudmailin_rows_by_default(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, facts = sources
    manifest = run_export(inbox, legacy, tmp_path / "out")
    expected = facts["mailhero_summaries"] + facts["cloudmailin_summaries"]
    assert manifest["tables"]["summaries"]["rows"] == expected
    assert manifest["tables"]["legacy_mail_text"]["rows"] == facts["texts_mailhero"] + facts["texts_cloudmailin"]
    db = d1_like(tmp_path)
    apply(db, tmp_path / "out", manifest)
    newer = db.execute(
        "SELECT subject, model FROM summaries WHERE event_id = ?",
        ("legacy:" + hashlib.sha256(b"cloudmailin-0").hexdigest(),),
    ).fetchone()
    assert newer == ("Old mail 0 (newer)", "gemini-2.5-flash")
    blank = db.execute("SELECT event_id, subject FROM summaries WHERE event_id LIKE 'legacy:row-%'").fetchall()
    assert len(blank) == 1 and blank[0][1] == ""


def test_without_text(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    manifest = run_export(inbox, legacy, tmp_path / "out", "--no-include-text")
    assert "legacy_mail_text" not in manifest["tables"]
    assert not (tmp_path / "out" / "04-legacy-text.sql").exists()


def test_verify_passes_after_import_and_rerun(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    manifest = run_export(inbox, legacy, tmp_path / "out", "--include-cloudmailin")
    db = d1_like(tmp_path)
    apply(db, tmp_path / "out", manifest)
    apply(db, tmp_path / "out", manifest)  # ON CONFLICT DO NOTHING + guarded appends
    # A row the Worker wrote itself is not part of the check.
    db.execute("INSERT INTO summaries VALUES ('live', 1, 's', 's', 'm', '', 0)")
    lines = verify_d1.verify(manifest, sqlite_query(db))
    assert lines == [
        f"PASS mail_events rows={manifest['tables']['mail_events']['rows']}",
        f"PASS mail_events state_counts {json.dumps(manifest['state_counts'])}",
        f"PASS mail_reminders rows={manifest['tables']['mail_reminders']['rows']}",
        f"PASS summaries rows={manifest['tables']['summaries']['rows']}",
        f"PASS legacy_mail_text rows={manifest['tables']['legacy_mail_text']['rows']}",
    ]


def test_verify_pages_by_rows_and_bytes(
    sources: tuple[Path, Path, dict], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inbox, legacy, _ = sources
    manifest = run_export(inbox, legacy, tmp_path / "out")
    db = d1_like(tmp_path)
    apply(db, tmp_path / "out", manifest)
    queries: list[str] = []
    base = sqlite_query(db)

    def counting(sql: str) -> list[dict]:
        queries.append(sql)
        return base(sql)

    monkeypatch.setattr(verify_d1, "PAGE_ROWS", 7)
    monkeypatch.setattr(verify_d1, "PAGE_BYTES", 50_000)
    assert all(line.startswith("PASS") for line in verify_d1.verify(manifest, counting))
    assert len(queries) > 20
    assert any("(source_id, event_id) >" in sql for sql in queries)


def test_verify_detects_changes(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    manifest = run_export(inbox, legacy, tmp_path / "out")
    db = d1_like(tmp_path)
    apply(db, tmp_path / "out", manifest)
    db.execute(
        "UPDATE legacy_mail_text SET text = text || '.' WHERE event_id = ?",
        (synthetic.event_id(synthetic.LONG_TEXT_EVENT),),
    )
    db.execute("DELETE FROM mail_reminders WHERE day = '2026-09-20'")
    db.execute("UPDATE mail_events SET state = 'failed_summary' WHERE event_id = ?", (synthetic.event_id(0),))
    failed = [line for line in verify_d1.verify(manifest, sqlite_query(db)) if line.startswith("FAIL")]
    assert failed == [
        "FAIL mail_events rows=40 expected=40 sha256_match=False",
        'FAIL mail_events state_counts {"complete": 38, "failed_summary": 1, "ignored": 1}',
        "FAIL mail_reminders rows=2 expected=3 sha256_match=False",
        "FAIL legacy_mail_text rows=46 expected=46 sha256_match=False",
    ]


# ---------------------------------------------------------------- safety and failure modes


def test_sources_are_opened_read_only(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    before = {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in (inbox, legacy)}
    run_export(inbox, legacy, tmp_path / "out")
    assert before == {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in (inbox, legacy)}
    connection = export_tool.open_readonly(inbox)
    with pytest.raises(sqlite3.OperationalError):
        connection.execute("DELETE FROM mail_inbox_reminders")


def test_output_never_echoes_content(
    sources: tuple[Path, Path, dict], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    inbox, legacy, _ = sources
    run_export(inbox, legacy, tmp_path / "out", "--include-cloudmailin")
    printed = capsys.readouterr()
    for secret in ("Synthetic", "summary", "合成", "Q3", "CloudMailin text"):
        assert secret not in printed.out + printed.err
    manifest_text = (tmp_path / "out" / "manifest.json").read_text()
    assert "Synthetic" not in manifest_text and "合成" not in manifest_text


def test_check_schema(sources: tuple[Path, Path, dict], tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    inbox, legacy, _ = sources
    assert export_tool.main(["--inbox", str(inbox), "--legacy", str(legacy), "--check-schema"]) == 0
    assert "schema check PASS" in capsys.readouterr().out
    assert not (tmp_path / "out").exists()
    with sqlite3.connect(legacy) as db:
        db.execute("ALTER TABLE database_entries RENAME COLUMN hash_id TO hash")
    assert export_tool.main(["--inbox", str(inbox), "--legacy", str(legacy), "--check-schema"]) == 1
    assert "legacy: database_entries.hash_id is missing" in capsys.readouterr().err


def test_refuses_a_non_empty_output_directory(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    out = tmp_path / "out"
    out.mkdir()
    (out / "keep").write_text("x")
    assert export_tool.main(["--inbox", str(inbox), "--legacy", str(legacy), "--out", str(out)]) == 2


@pytest.mark.parametrize(
    ("sql", "message"),
    [
        ("UPDATE mail_inbox_events SET source_id = 'other' WHERE rowid = 1", "another source_id"),
        ("UPDATE mail_inbox_events SET payload_hash = x'00' WHERE rowid = 1", "32-byte BLOB"),
        ("UPDATE mail_inbox_events SET payload_hash = hex(payload_hash) WHERE rowid = 1", "32-byte BLOB"),
        ("UPDATE mail_inbox_reminders SET day = '2026/09/20' WHERE rowid = 1", "malformed day"),
    ],
)
def test_broken_invariants_stop_the_export(
    sources: tuple[Path, Path, dict], tmp_path: Path, sql: str, message: str, capsys: pytest.CaptureFixture[str]
) -> None:
    inbox, legacy, _ = sources
    with sqlite3.connect(inbox) as db:
        db.execute(sql)
    assert export_tool.main(["--inbox", str(inbox), "--legacy", str(legacy), "--out", str(tmp_path / "o")]) == 2
    assert message in capsys.readouterr().err


def test_active_rows_and_bad_text_are_warnings(sources: tuple[Path, Path, dict], tmp_path: Path) -> None:
    inbox, legacy, _ = sources
    with sqlite3.connect(inbox) as db:
        db.execute("UPDATE mail_inbox_events SET state = 'todo_unknown' WHERE event_id = ?", (synthetic.event_id(3),))
        db.execute("UPDATE mail_inbox_reminders SET state = 'sending' WHERE day = '2026-09-22'")
    with sqlite3.connect(legacy) as db:
        db.execute("UPDATE database_entries SET text = CAST(x'ff41' AS TEXT) WHERE id = 2")
    manifest = run_export(inbox, legacy, tmp_path / "out")
    warnings = {(w["code"], w["detail"]) for w in manifest["warnings"]}
    assert ("active_event", f"{synthetic.event_id(3)} todo_unknown") in warnings
    assert ("reminder_sending", "2026-09-22") in warnings
    assert ("invalid_utf8_replaced", "1 values") in warnings


def test_every_table_spec_matches_the_migration(tmp_path: Path) -> None:
    db = d1_like(tmp_path)
    for spec in TABLES:
        columns = {row[1] for row in db.execute(f"PRAGMA table_info({spec.name})")}
        assert set(spec.columns) <= columns, spec.name
    summary_columns = [row[1] for row in db.execute("PRAGMA table_info(summaries)")]
    assert tuple(summary_columns) == SUMMARIES.columns
