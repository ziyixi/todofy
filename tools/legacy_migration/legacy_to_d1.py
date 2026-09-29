#!/usr/bin/env python3
"""Export the retired Go service's SQLite data as D1 import files.

Reads ``inbox.sqlite`` (Mail Hero inbox ledger, mail_inbox.go @ 6c46ed4) and
``todofy.db`` (GORM ``database_entries``, database/database.go:42-51) strictly
read-only and writes, for migrations/0001_init.sql:

  01-ledger.sql     mail_events      (imported = 1, payload NULL)
  02-reminders.sql  mail_reminders   (imported = 1)
  03-summaries.sql  summaries        (imported = 1)
  04-legacy-text.sql legacy_mail_text (expires_at NULL; skipped with --no-include-text)
  manifest.json     counts, per-table normalized SHA-256, file hashes, warnings

Mail Hero-era cache rows get their ledger event's ID. CloudMailin-era rows (and
Mail Hero rows whose event is missing) are imported as ``legacy:<hash>`` /
``legacy:row-<id>``: they are an archive. The reports read them for their day,
but no UI page lists them and the owner API only serves their text by exact ID
(``GET /api/v1/legacy_text/legacy:...``); use ``wrangler d1 execute`` to browse
them. ``--skip-cloudmailin`` leaves them out (the manifest then warns).

Every statement is an ``INSERT ... ON CONFLICT DO NOTHING`` below D1's 100 KB
statement limit; longer values are appended by UPDATEs guarded on the current
byte length, so re-running any file (even after a partial run) is safe. Row
contents are never printed. Stdlib only; runs on Python 3.9+.
"""

from __future__ import annotations

import argparse
import calendar
import hashlib
import html
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

FORMAT = "todofy-legacy-export-v1"
DEFAULT_SOURCE_ID = "mail-hero-personal"
# Equal to todofy.core.render.SUBJECT_LABEL (a test pins it); duplicated so this
# file runs alone on a host without the worker tree.
SUBJECT_LABEL = "**SUBJECT: "
MAILHERO_HASH_PREFIX = "mailhero-v1-"  # mail_inbox_worker.go:300-307
MAX_STATEMENT_BYTES = 90_000
CHUNK_BYTES = 80_000
MAX_VALUE_BYTES = 1_900_000  # D1 rows are capped at 2,000,000 bytes

EVENT_STATES = frozenset(
    {
        "pending",
        "summarizing",
        "summarized",
        "todo_sending",
        "todo_unknown",
        "todo_created",
        "complete",
        "ignored",
        "failed_summary",
    }
)
TERMINAL_STATES = frozenset({"complete", "ignored"})
REMINDER_STATES = frozenset({"sending", "created", "unknown", "failed"})
DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")

# protos proto/todofy/large_language_model.proto:15-55 (enum Model, 0-18), frozen
# before the proto is retired. Names for 8-18 are llm/consts.go:7-19; the rest
# derive from the enum name exactly as the proto comments spell them.
MODELS: dict[int, tuple[str, str]] = {
    0: ("MODEL_UNSPECIFIED", "unspecified"),
    1: ("MODEL_GEMINI_2_0_PRO_EXP_02_05", "gemini-2.0-pro-exp-02-05"),
    2: ("MODEL_GEMINI_1_5_PRO", "gemini-1.5-pro"),
    3: ("MODEL_GEMINI_2_0_FLASH", "gemini-2.0-flash"),
    4: ("MODEL_GEMINI_1_5_FLASH", "gemini-1.5-flash"),
    5: ("MODEL_GEMINI_2_5_PRO_EXP_03_25", "gemini-2.5-pro-exp-03-25"),
    6: ("MODEL_GEMINI_2_5_FLASH_PREVIEW_04_17", "gemini-2.5-flash-preview-04-17"),
    7: ("MODEL_GEMINI_2_0_FLASH_LITE", "gemini-2.0-flash-lite"),
    8: ("MODEL_GEMINI_2_5_PRO", "gemini-2.5-pro"),
    9: ("MODEL_GEMINI_2_5_FLASH", "gemini-2.5-flash"),
    10: ("MODEL_GEMINI_2_5_FLASH_LITE", "gemini-2.5-flash-lite"),
    11: ("MODEL_GEMINI_3_FLASH_PREVIEW", "gemini-3-flash-preview"),
    12: ("MODEL_GEMINI_3_8_FLASH", "gemini-3.8-flash"),
    13: ("MODEL_GEMINI_3_7_FLASH", "gemini-3.7-flash"),
    14: ("MODEL_GEMINI_3_6_FLASH", "gemini-3.6-flash"),
    15: ("MODEL_GEMINI_3_5_FLASH", "gemini-3.5-flash"),
    16: ("MODEL_GEMINI_3_5_FLASH_LITE", "gemini-3.5-flash-lite"),
    17: ("MODEL_GEMINI_3_1_FLASH_LITE", "gemini-3.1-flash-lite"),
    18: ("MODEL_GEMINI_3_1_PRO_PREVIEW", "gemini-3.1-pro-preview"),
}

# Columns --check-schema requires (name -> declared type, lowercased).
EXPECTED_SCHEMA: dict[str, dict[str, dict[str, str]]] = {
    "inbox": {
        "mail_inbox_events": {
            "source_id": "text",
            "event_id": "text",
            "payload_hash": "blob",
            "payload": "blob",
            "state": "text",
            "summary": "text",
            "summary_model": "integer",
            "todo_body": "text",
            "task_id": "text",
            "attempt_count": "integer",
            "next_attempt_at": "integer",
            "last_error_code": "text",
            "created_at": "integer",
            "updated_at": "integer",
        },
        "mail_inbox_reminders": {
            "day": "text",
            "state": "text",
            "task_id": "text",
            "subject": "text",
            "body": "text",
            "attention_count": "integer",
            "attempts": "integer",
            "next_attempt_at": "integer",
            "last_error_code": "text",
            "created_at": "integer",
            "updated_at": "integer",
        },
    },
    "legacy": {
        "database_entries": {
            "id": "integer",
            "created_at": "datetime",
            "updated_at": "datetime",
            "deleted_at": "datetime",
            "model_family": "integer",
            "llm_model": "integer",
            "prompt": "text",
            "max_tokens": "integer",
            "text": "text",
            "summary": "text",
            "hash_id": "text",
        },
    },
}


@dataclass(frozen=True)
class TableSpec:
    """One D1 target table: the columns the export writes and the rows it owns."""

    name: str
    file: str
    columns: tuple[str, ...]
    key: tuple[str, ...]
    owned: str  # SQL condition selecting the rows this export wrote
    chunk_column: str | None = None  # the only column allowed to exceed one statement

    def row_key(self, row: Sequence[Any]) -> tuple[Any, ...]:
        return tuple(row[self.columns.index(name)] for name in self.key)


LEDGER = TableSpec(
    "mail_events",
    "01-ledger.sql",
    (
        "source_id",
        "event_id",
        "payload_hash",
        "payload",
        "state",
        "version",
        "summary",
        "summary_model",
        "todo_body",
        "todoist_request_id",
        "task_id",
        "attempt_count",
        "crashes",
        "next_attempt_at",
        "last_error_code",
        "imported",
        "created_at",
        "updated_at",
    ),
    ("source_id", "event_id"),
    "imported = 1",
)
REMINDERS = TableSpec(
    "mail_reminders",
    "02-reminders.sql",
    (
        "day",
        "state",
        "task_id",
        "subject",
        "body",
        "attention_count",
        "attempts",
        "next_attempt_at",
        "last_error_code",
        "imported",
        "created_at",
        "updated_at",
    ),
    ("day",),
    "imported = 1",
)
SUMMARIES = TableSpec(
    "summaries",
    "03-summaries.sql",
    ("event_id", "created_at", "subject", "summary", "model", "task_id", "imported"),
    ("event_id",),
    "imported = 1",
    chunk_column="summary",
)
LEGACY_TEXT = TableSpec(
    "legacy_mail_text",
    "04-legacy-text.sql",
    ("event_id", "created_at", "text", "expires_at"),
    ("event_id",),
    "1 = 1",  # only this import ever writes the table
    chunk_column="text",
)
TABLES = (LEDGER, REMINDERS, SUMMARIES, LEGACY_TEXT)


class ExportError(Exception):
    """The source data breaks an invariant; the message never contains row content."""


# ---------------------------------------------------------------- normalization


def row_line(row: Sequence[Any]) -> str:
    return json.dumps(list(row), ensure_ascii=False, separators=(",", ":"))


def table_digest(spec: TableSpec, rows: Iterable[Sequence[Any]]) -> tuple[int, str]:
    """(row count, SHA-256 over the rows' JSON lines in primary-key order)."""
    ordered = sorted(rows, key=spec.row_key)
    digest = hashlib.sha256()
    for row in ordered:
        digest.update(row_line(row).encode())
        digest.update(b"\n")
    return len(ordered), digest.hexdigest()


# ---------------------------------------------------------------- SQL output


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise TypeError(f"unsupported SQL value type {type(value).__name__}")
    if isinstance(value, int):
        return str(value)
    if "\x00" in value:
        # A NUL would end the statement in SQLite's tokenizer; a blob cast keeps it.
        return f"CAST(X'{value.encode().hex()}' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def _utf8_len(value: str) -> int:
    return len(value.encode())


def _split_literal(value: str, first_budget: int, budget: int) -> Iterator[str]:
    """Consecutive pieces of ``value`` whose SQL literals fit the byte budgets."""
    hexed = "\x00" in value  # any piece may then need the hex form: budget for it
    overhead = len("CAST(X'' AS TEXT)") if hexed else 2
    start, used, limit = 0, overhead, first_budget
    for index, char in enumerate(value):
        cost = 2 * _utf8_len(char) if hexed else 2 if char == "'" else _utf8_len(char)
        if used + cost > limit and index > start:
            yield value[start:index]
            start, used, limit = index, overhead, budget
        used += cost
    yield value[start:]


def _where_key(spec: TableSpec, row: Sequence[Any]) -> str:
    return " AND ".join(f"{name} = {sql_literal(row[spec.columns.index(name)])}" for name in spec.key)


def row_statements(spec: TableSpec, row: Sequence[Any]) -> list[str]:
    """INSERT for one row, plus length-guarded appends when a value is too long."""
    columns = ", ".join(spec.columns)

    def insert(values: Sequence[Any]) -> str:
        literals = ", ".join(sql_literal(value) for value in values)
        return f"INSERT INTO {spec.name} ({columns}) VALUES ({literals}) ON CONFLICT DO NOTHING;"

    statement = insert(row)
    if _utf8_len(statement) <= MAX_STATEMENT_BYTES:
        return [statement]
    if spec.chunk_column is None:
        raise ExportError(f"{spec.name} row {spec.row_key(row)!r} exceeds the statement limit")
    position = spec.columns.index(spec.chunk_column)
    value: str = row[position]
    base = insert([*row[:position], "", *row[position + 1 :]])
    first_budget = min(CHUNK_BYTES, MAX_STATEMENT_BYTES - _utf8_len(base))
    if first_budget < 1_000:
        raise ExportError(f"{spec.name} row {spec.row_key(row)!r} has oversized short columns")
    pieces = list(_split_literal(value, first_budget, CHUNK_BYTES))
    statements = [insert([*row[:position], pieces[0], *row[position + 1 :]])]
    done = _utf8_len(pieces[0])
    column = spec.chunk_column
    for piece in pieces[1:]:
        # The guard makes a re-run a no-op and lets a partial run resume in order.
        statements.append(
            f"UPDATE {spec.name} SET {column} = {column} || {sql_literal(piece)}"
            f" WHERE {_where_key(spec, row)} AND length(CAST({column} AS BLOB)) = {done};"
        )
        done += _utf8_len(piece)
    for text in statements:
        if _utf8_len(text) > MAX_STATEMENT_BYTES:
            raise AssertionError("chunking produced an oversized statement")
    return statements


# ---------------------------------------------------------------- source reading


def open_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise ExportError(f"source database not found: {path}")
    connection = sqlite3.connect(f"file:{quote(str(path.resolve()))}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only = 1")
    return connection


class Utf8Decoder:
    """sqlite3 text_factory that keeps going on invalid UTF-8 and counts it."""

    def __init__(self) -> None:
        self.replaced = 0

    def __call__(self, raw: bytes) -> str:
        try:
            return raw.decode()
        except UnicodeDecodeError:
            self.replaced += 1
            return raw.decode(errors="replace")


def check_schema(connection: sqlite3.Connection, which: str) -> list[str]:
    """Problems with one source database's layout; empty when it matches."""
    problems = []
    for table, expected in EXPECTED_SCHEMA[which].items():
        actual = {str(row[1]): str(row[2]).lower() for row in connection.execute(f"PRAGMA table_info({table})")}
        if not actual:
            problems.append(f"{which}: table {table} is missing")
            continue
        for column, declared in expected.items():
            if column not in actual:
                problems.append(f"{which}: {table}.{column} is missing")
            elif actual[column] != declared:
                problems.append(f"{which}: {table}.{column} is {actual[column]!r}, expected {declared!r}")
    return problems


_GORM_TIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?"
    r"\s*(Z|[+-][0-9]{2}:?[0-9]{2})?\Z"
)


def gorm_time(value: Any) -> tuple[int, int]:
    """(Unix seconds, nanoseconds) of a mattn/go-sqlite3 timestamp; no zone means UTC."""
    if isinstance(value, int) and not isinstance(value, bool):
        return value, 0
    match = _GORM_TIME.match(value.strip()) if isinstance(value, str) else None
    if not match:
        raise ValueError("unparsable timestamp")
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    fraction = (match.group(7) or "").ljust(9, "0")
    zone = match.group(8) or "Z"
    offset = 0
    if zone != "Z":
        digits = zone[1:].replace(":", "")
        offset = (int(digits[:2]) * 60 + int(digits[2:])) * 60 * (-1 if zone[0] == "-" else 1)
    seconds = calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0)) - offset
    return seconds, int(fraction)


def model_name(number: Any) -> str:
    entry = MODELS.get(number) if isinstance(number, int) else None
    return entry[1] if entry else f"legacy-model-{number}"


def parse_subject(summary: str) -> str:
    """The subject from the task header (html/template-escaped by the Go service)."""
    for line in summary.split("\n"):
        if line.startswith(SUBJECT_LABEL) and line.endswith("**"):
            return html.unescape(line[len(SUBJECT_LABEL) : -2])
    return ""


def mailhero_hash_id(source_id: str, event_id: str) -> str:
    return MAILHERO_HASH_PREFIX + hashlib.sha256(f"{source_id}\x00{event_id}".encode()).hexdigest()


# ---------------------------------------------------------------- export


@dataclass
class Export:
    rows: dict[str, list[tuple[Any, ...]]]
    state_counts: dict[str, int]
    reminder_state_counts: dict[str, int]
    stats: dict[str, int]
    warnings: list[dict[str, str]]


def _int(value: Any, what: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ExportError(f"{what} is not a non-negative integer")
    return value


def read_ledger(inbox: sqlite3.Connection, source_id: str, export: Export) -> dict[str, tuple[str, str]]:
    """Fill mail_events rows; return {Mail Hero cache hash_id: (event_id, task_id)}."""
    links = {}
    cursor = inbox.execute(
        "SELECT source_id, event_id, payload_hash, typeof(payload_hash), state, task_id, attempt_count,"
        " last_error_code, created_at, updated_at FROM mail_inbox_events ORDER BY source_id, event_id"
    )
    for row_source, event_id, payload_hash, hash_type, state, task_id, attempts, code, created, updated in cursor:
        if row_source != source_id:
            raise ExportError(f"inbox holds events of another source_id (expected {source_id!r})")
        if hash_type != "blob" or len(payload_hash) != 32:
            raise ExportError(f"event {event_id}: payload_hash is not a 32-byte BLOB")
        if state not in EVENT_STATES:
            raise ExportError(f"event {event_id}: unknown state")
        if state not in TERMINAL_STATES:
            # The cutover drains the old inbox first; an active row has no payload here.
            export.warnings.append({"code": "active_event", "detail": f"{event_id} {state}"})
        export.rows[LEDGER.name].append(
            (
                source_id,
                event_id,
                payload_hash.hex(),
                None,
                state,
                1,
                "",
                "",
                "",
                "",
                task_id,
                _int(attempts, f"event {event_id} attempt_count"),
                0,
                0,
                code,
                1,
                _int(created, f"event {event_id} created_at"),
                _int(updated, f"event {event_id} updated_at"),
            )
        )
        export.state_counts[state] = export.state_counts.get(state, 0) + 1
        links[mailhero_hash_id(source_id, event_id)] = (event_id, task_id)
    return links


def read_reminders(inbox: sqlite3.Connection, export: Export) -> None:
    # The frozen subject and body come along: the Worker retries a same-day ``failed``
    # reminder with exactly these bytes, as the Go worker did.
    cursor = inbox.execute(
        "SELECT day, state, task_id, subject, body, attention_count, attempts, next_attempt_at,"
        " last_error_code, created_at, updated_at FROM mail_inbox_reminders ORDER BY day"
    )
    for day, state, task_id, subject, body, attention, attempts, next_at, code, created, updated in cursor:
        if not isinstance(day, str) or not DAY.match(day):
            raise ExportError("mail_inbox_reminders has a malformed day")
        if state not in REMINDER_STATES:
            raise ExportError(f"reminder {day}: unknown state")
        if state == "sending":
            export.warnings.append({"code": "reminder_sending", "detail": day})
        export.rows[REMINDERS.name].append(
            (
                day,
                state,
                task_id,
                subject or "",
                body or "",
                _int(attention, f"reminder {day} attention_count"),
                _int(attempts, f"reminder {day} attempts"),
                _int(next_at or 0, f"reminder {day} next_attempt_at"),
                code,
                1,
                _int(created, f"reminder {day} created_at"),
                _int(updated, f"reminder {day} updated_at"),
            )
        )
        export.reminder_state_counts[state] = export.reminder_state_counts.get(state, 0) + 1


@dataclass(frozen=True)
class Entry:
    id: int
    created_at: int
    updated: tuple[int, int]
    model: Any
    text: str
    summary: str
    hash_id: str


def read_entries(legacy: sqlite3.Connection, stats: Counter) -> list[Entry]:
    """Live cache rows, one per hash_id (newest updated_at wins); blank hashes stay separate."""
    newest: dict[str, Entry] = {}
    loose: list[Entry] = []
    cursor = legacy.execute(
        "SELECT id, created_at, updated_at, deleted_at, llm_model, text, summary, hash_id"
        " FROM database_entries ORDER BY id"
    )
    for row_id, created, updated, deleted, model, text, summary, hash_id in cursor:
        if deleted is not None:
            stats["entries_soft_deleted"] += 1
            continue
        stats["entries_live"] += 1
        try:
            entry = Entry(
                id=row_id,
                created_at=gorm_time(created)[0],
                updated=gorm_time(updated if updated is not None else created),
                model=model,
                text=text or "",
                summary=summary or "",
                hash_id=(hash_id or "").strip(),
            )
        except ValueError:
            raise ExportError(f"database_entries id {row_id}: unparsable created_at/updated_at") from None
        if not entry.hash_id:
            stats["entries_blank_hash"] += 1
            loose.append(entry)
            continue
        current = newest.get(entry.hash_id)
        if current is not None:
            stats["entries_duplicate_dropped"] += 1
            if (entry.updated, entry.id) < (current.updated, current.id):
                continue
        newest[entry.hash_id] = entry
    return [*newest.values(), *loose]


def read_summaries(
    legacy: sqlite3.Connection,
    links: dict[str, tuple[str, str]],
    export: Export,
    *,
    include_text: bool,
    include_cloudmailin: bool,
) -> None:
    stats: Counter = Counter()
    unlinked = 0
    for entry in read_entries(legacy, stats):
        task_id = ""
        if entry.hash_id.startswith(MAILHERO_HASH_PREFIX):
            stats["mailhero_entries"] += 1
            if entry.hash_id in links:
                event_id, task_id = links[entry.hash_id]
            else:
                unlinked += 1
                event_id = f"legacy:{entry.hash_id}"
        else:
            # CloudMailin-era rows: sha256(prompt + content) or blank, tied to no event.
            stats["cloudmailin_entries"] += 1
            if not include_cloudmailin:
                stats["cloudmailin_skipped"] += 1
                continue
            event_id = f"legacy:{entry.hash_id}" if entry.hash_id else f"legacy:row-{entry.id}"
        subject = parse_subject(entry.summary)
        if not subject:
            stats["summaries_without_subject"] += 1
        if _utf8_len(entry.summary) > MAX_VALUE_BYTES:
            raise ExportError(f"summary of {event_id} exceeds the D1 row limit")
        export.rows[SUMMARIES.name].append(
            (event_id, entry.created_at, subject, entry.summary, model_name(entry.model), task_id, 1)
        )
        if not include_text:
            continue
        if not entry.text:
            stats["texts_empty_skipped"] += 1
        elif _utf8_len(entry.text) > MAX_VALUE_BYTES:
            export.warnings.append({"code": "text_too_large_skipped", "detail": event_id})
        else:
            export.rows[LEGACY_TEXT.name].append((event_id, entry.created_at, entry.text, None))
    if unlinked:
        export.warnings.append({"code": "mailhero_entry_unlinked", "detail": f"{unlinked} cache rows"})
    if stats["cloudmailin_skipped"]:
        # An opt-out must not pass the cutover gate ("warnings empty") silently.
        export.warnings.append({"code": "cloudmailin_skipped", "detail": f"{stats['cloudmailin_skipped']} cache rows"})
    export.stats.update(stats)


def build_export(
    inbox: sqlite3.Connection,
    legacy: sqlite3.Connection,
    source_id: str,
    *,
    include_text: bool,
    include_cloudmailin: bool,
) -> Export:
    export = Export({spec.name: [] for spec in TABLES}, {}, {}, {}, [])
    links = read_ledger(inbox, source_id, export)
    read_reminders(inbox, export)
    read_summaries(legacy, links, export, include_text=include_text, include_cloudmailin=include_cloudmailin)
    return export


def write_sql(path: Path, spec: TableSpec, rows: list[tuple[Any, ...]], warnings: list[dict[str, str]]) -> int:
    count = 0
    with open(path, "w", encoding="utf-8", newline="\n", opener=_private_opener) as out:
        out.write(f"-- {spec.name}: generated by tools/legacy_migration/legacy_to_d1.py ({FORMAT})\n")
        for row in sorted(rows, key=spec.row_key):
            statements = row_statements(spec, row)
            if len(statements) > 1:
                warnings.append({"code": f"{spec.chunk_column}_chunked", "detail": str(spec.row_key(row)[0])})
            for statement in statements:
                out.write(statement)
                out.write("\n")
            count += len(statements)
    return count


def _private_opener(path: str, flags: int) -> int:
    # The files carry mail content: owner-only permissions.
    return os.open(path, flags, 0o600)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_export(export: Export, out: Path, *, source_id: str, include_text: bool, include_cloudmailin: bool) -> dict:
    if out.exists() and any(out.iterdir()):
        raise ExportError(f"output directory is not empty: {out}")
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "format": FORMAT,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),  # noqa: UP017 (3.9)
        "source_id": source_id,
        "options": {"include_text": include_text, "include_cloudmailin": include_cloudmailin},
        "state_counts": dict(sorted(export.state_counts.items())),
        "reminder_state_counts": dict(sorted(export.reminder_state_counts.items())),
        "tables": {},
        "files": {},
        "stats": dict(sorted(export.stats.items())),
        "warnings": export.warnings,
    }
    for spec in TABLES:
        if spec is LEGACY_TEXT and not include_text:
            continue
        rows = export.rows[spec.name]
        path = out / spec.file
        statements = write_sql(path, spec, rows, export.warnings)
        count, digest = table_digest(spec, rows)
        manifest["tables"][spec.name] = {"file": spec.file, "rows": count, "sha256": digest}
        manifest["files"][spec.file] = {
            "bytes": path.stat().st_size,
            "statements": statements,
            "sha256": file_sha256(path),
        }
    with open(out / "manifest.json", "w", encoding="utf-8", opener=_private_opener) as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--inbox", type=Path, required=True, help="inbox.sqlite (a snapshot.py copy)")
    parser.add_argument("--legacy", type=Path, required=True, help="todofy.db (a snapshot.py copy)")
    parser.add_argument("--out", type=Path, help="new or empty output directory")
    parser.add_argument("--source-id", default=DEFAULT_SOURCE_ID)
    parser.add_argument(
        "--include-text",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="export full mail text into legacy_mail_text (default: on)",
    )
    parser.add_argument(
        "--include-cloudmailin",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="export CloudMailin-era cache rows too, as legacy:<hash> archive rows (default: on)",
    )
    parser.add_argument(
        "--skip-cloudmailin",
        dest="include_cloudmailin",
        action="store_false",
        help="leave CloudMailin-era cache rows out (same as --no-include-cloudmailin; the manifest warns)",
    )
    parser.add_argument("--check-schema", action="store_true", help="only compare the source schemas and exit")
    args = parser.parse_args(argv)
    if not args.check_schema and args.out is None:
        parser.error("--out is required unless --check-schema is given")
    try:
        decoder = Utf8Decoder()
        inbox, legacy = open_readonly(args.inbox), open_readonly(args.legacy)
        inbox.text_factory = legacy.text_factory = decoder
        problems = check_schema(inbox, "inbox") + check_schema(legacy, "legacy")
        for problem in problems:
            print(f"schema: {problem}", file=sys.stderr)
        if problems:
            print("schema check FAIL", file=sys.stderr)
            return 1
        print("schema check PASS")
        if args.check_schema:
            return 0
        export = build_export(
            inbox,
            legacy,
            args.source_id,
            include_text=args.include_text,
            include_cloudmailin=args.include_cloudmailin,
        )
        if decoder.replaced:
            export.warnings.append({"code": "invalid_utf8_replaced", "detail": f"{decoder.replaced} values"})
        manifest = write_export(
            export,
            args.out,
            source_id=args.source_id,
            include_text=args.include_text,
            include_cloudmailin=args.include_cloudmailin,
        )
    except (ExportError, sqlite3.Error) as error:
        print(f"export FAIL: {error}", file=sys.stderr)
        return 2
    for name, table in manifest["tables"].items():
        print(f"{name}: {table['rows']} rows -> {table['file']}")
    print(f"state_counts: {json.dumps(manifest['state_counts'])}")
    print(f"warnings: {len(manifest['warnings'])} (see manifest.json)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
