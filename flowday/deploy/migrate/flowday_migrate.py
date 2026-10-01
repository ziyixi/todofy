#!/usr/bin/env python3
"""Move the container-era FlowDay SQLite file into the D1 database "flowday" (F4, docs/design.md section 11).

Standard library only (Python 3.9+), plus the pinned wrangler in flowday/worker/node_modules for D1. Run it from
anywhere; every path it writes is a private work directory on a local disk, outside this repository and outside
any cloud-synced folder (`mktemp -d` gives one).

    python3 flowday/deploy/migrate/flowday_migrate.py export --source COPY/flowday.db --workdir PRIVATE_DIR \
        --expect-sha256 COPY/host.sha256
    python3 flowday/deploy/migrate/flowday_migrate.py check-empty --remote
    python3 flowday/deploy/migrate/flowday_migrate.py import --workdir PRIVATE_DIR --remote
    python3 flowday/deploy/migrate/flowday_migrate.py verify --workdir PRIVATE_DIR --remote
    python3 flowday/deploy/migrate/flowday_migrate.py reset --remote --bookmark-env FLOWDAY_D1_BOOKMARK
    python3 flowday/deploy/migrate/flowday_migrate.py reset --remote --delete-all-rows --workdir PRIVATE_DIR

Each D1 command takes --remote (the production D1, with wrangler's own auth: CLOUDFLARE_API_TOKEN or a wrangler
login) or --local --persist-to DIR (a local D1 with the migrations applied; the tests use it). Every wrangler call
runs with WRANGLER_WRITE_LOGS=false and a throwaway WRANGLER_LOG_PATH: wrangler otherwise appends everything it
prints, query results included, to a debug log under its global config directory and keeps it for 30 days.

export
    SOURCE is a local copy of the container's flowday.db, taken while the container was stopped; SOURCE-wal, when
    present, is its WAL. --expect-sha256 FILE (the `sha256sum flowday.db*` output recorded on the host after the
    stop) must then match the copied files. The copy is never opened: both files are copied into WORKDIR/stage
    (mode 0700), the staged copy is opened read-write so SQLite applies its WAL, checkpointed and switched to
    journal_mode=DELETE, checked (integrity_check), and moved to WORKDIR/snapshot.db. `file:<copy>?immutable=1`
    alone would ignore the WAL and silently lose its commits. The SOURCE files are hashed before and after and must
    be byte-identical (and no file may appear next to them).
    Then every table of migrations/0001_init.sql is written to WORKDIR/import.sql as one INSERT per row with named
    columns and plain SQL literals (no unistr(); a text holding a control character or a transaction keyword as one
    CAST(X'<utf-8>' AS TEXT)), the settings row todoist_api_key left out. A row whose primary key is NULL is
    refused. No foreign keys exist, so table order is free. One file, because wrangler imports a --remote file
    atomically ("your DB will return to its original state"). No statement is longer than D1's 100,000-byte limit:
    a long text is inserted empty and appended in chunks (UPDATE ... SET c = c || '...').
    WORKDIR/manifest.json holds only counts, lengths and SHA-256 digests.
check-empty
    The 7 tables exist with the committed schema, every committed migration is applied, and no table has a row.
import
    The daily write budget (below), check-empty, then `wrangler d1 execute DB --file WORKDIR/import.sql --yes`.
    wrangler's output stays in WORKDIR/wrangler-import.log (an error message may quote the SQL); only counts are
    printed.
verify
    Per table: count(*), total(length(col)) per text or BLOB column and the SHA-256 of the sorted canonical row
    dump, from D1 (read-only SELECTs) against the manifest and against WORKDIR/snapshot.db again. Also: no
    todoist_api_key row in D1, and the D1-only columns (tasks.todoist_project_id) all NULL. Prints only counts and
    equal/DIFFERENT.
reset
    --bookmark-env NAME restores the D1 Time Travel bookmark held in that environment variable (never printed), or
    --delete-all-rows --workdir WORKDIR deletes every row of the 7 tables (one atomic file; d1_migrations stays),
    within the daily write budget. Then check-empty.

Daily write budget: the account's Free allowance is 100,000 D1 rows written per UTC day, shared by every app.
import and reset --delete-all-rows record their estimated rows written (index entries included) per UTC day in
WORKDIR/d1-writes.json and refuse to go above --max-rows-written-per-day (50,000) for the day. A Time Travel restore
writes no rows through SQL and is not counted.

Nothing prints a row's content: only table names, counts, byte totals, digest prefixes (export) or digest
equality (verify). Exit status: 0 done, 1 a check failed, 2 a usage, environment or tool error.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

APP = Path(__file__).resolve().parents[2]  # flowday/
REPO = APP.parent
MIGRATIONS = APP / "migrations"
WORKER = APP / "worker"
CONFIG = APP / "wrangler.toml"
BINDING = "DB"

# D1 limits (https://developers.cloudflare.com/d1/platform/limits/): a statement is at most 100,000 bytes, and a
# string, BLOB or row at most 2,000,000 bytes. Statements are kept under STATEMENT_BUDGET for headroom.
D1_MAX_STATEMENT_BYTES = 100_000
STATEMENT_BUDGET = 90_000
D1_MAX_VALUE_BYTES = 2_000_000
# The account's Free allowance is 100,000 rows written per UTC day, shared by every app (index entries count as
# rows). One import file, and everything this tool writes from one work directory in one UTC day, stay under half.
DEFAULT_MAX_ROWS_WRITTEN = 50_000
LEDGER = "d1-writes.json"
# 2: lengths cover only text and BLOBs, reals compare by digest (+-Inf included).
MANIFEST_FORMAT = 2
# Rows per SELECT page and SELECT pages per wrangler call when reading D1.
PAGE_ROWS = 1_000
PAGES_PER_CALL = 10

# The Todoist key is never exported: the Worker reads only a key sealed under its own secret (docs/design.md 3).
EXCLUDED_SETTINGS = ("todoist_api_key",)
# Keys only the Worker's sync writes; the container never had them, so a source holding one is not a container file.
WORKER_ONLY_SETTINGS = ("todoist_sync_token", "todoist_projects", "sync_claimed_at", "todoist_sync_pending")

WAL_MAGIC = (0x377F0682, 0x377F0683)
# A text holding a C0 control (newline and tab aside) or DEL is written as hex: SQL files carry no raw controls.
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
# Substrings wrangler's SQL-file trimmer acts on anywhere in the file, string literals included (wrangler-dist
# src/d1/trimmer.ts): a text holding one is written as hex too.
TRANSACTION_MARKERS = ("BEGIN TRANSACTION", "COMMIT;")
# Above the largest finite double: only +-Inf compares beyond it (D1's JSON turns Inf into null).
MAX_DOUBLE = "1.7976931348623157e308"
# Folders a sync client uploads (relative to the home directory): never a place for the snapshot or import.sql.
CLOUD_SYNCED = (
    "Library/CloudStorage",  # Google Drive, OneDrive, Dropbox, Box (File Provider)
    "Library/Mobile Documents",  # iCloud Drive
    "Desktop",  # iCloud "Desktop & Documents"
    "Documents",
    "Dropbox",
    "OneDrive",
    "Google Drive",
    "Box",
)
SHA256SUM_LINE = re.compile(r"^([0-9a-fA-F]{64}) [ *](.+)$")
READ_ONLY = re.compile(r"^\s*(SELECT\b|PRAGMA table_info\()", re.I)


class Failure(Exception):
    """A check failed (exit 1). The message never holds row content."""


class ToolError(Exception):
    """A usage, environment or tool error (exit 2). The message never holds row content."""


# --- Schemas, from the committed migrations ---------------------------------------------------------------------


@dataclass(frozen=True)
class Table:
    name: str
    columns: tuple[str, ...]
    primary_key: str
    indexes: int  # index b-trees a row insert writes (automatic ones included): D1 bills each as a row


def migration_files() -> list[Path]:
    return sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql"))


def schema(files: Sequence[Path]) -> dict[str, Table]:
    """The tables created by `files` (applied in order to an in-memory SQLite), in creation order."""
    db = sqlite3.connect(":memory:")
    try:
        for path in files:
            db.executescript(path.read_text())
        tables = {}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid"):
            info = db.execute(f"PRAGMA table_info({ident(name)})").fetchall()
            keys = [row[1] for row in info if row[5]]
            if len(keys) != 1:
                raise ToolError(f"table {name} must have a one-column primary key")
            (indexes,) = db.execute(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", (name,)
            ).fetchone()
            tables[name] = Table(name, tuple(row[1] for row in info), keys[0], indexes)
        return tables
    finally:
        db.close()


def source_schema() -> dict[str, Table]:
    """The container's tables: migration 0001 is its schema, unchanged."""
    return schema(migration_files()[:1])


def target_schema() -> dict[str, Table]:
    """D1's tables after every committed migration."""
    return schema(migration_files())


# --- SQL text --------------------------------------------------------------------------------------------------


def ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def needs_hex(value: str) -> bool:
    """True for a text a plain quoted literal cannot carry through wrangler and D1 unchanged."""
    return CONTROL.search(value) is not None or any(marker in value for marker in TRANSACTION_MARKERS)


def text_literal(value: str) -> str:
    """One SQL operand for `value`, never unistr() and never a concatenation.

    Plain text is a quoted literal. A text holding a control character (CR, NUL, ...) or a transaction keyword
    that wrangler's trimmer would act on is CAST(X'<its UTF-8 bytes>' AS TEXT): exact for every byte, NUL included,
    and an expression of depth 1 however many such characters it holds (a chain of `char(N) || ...` operands hits
    D1's expression depth limit of 100 after about 50 of them).
    """
    if needs_hex(value):
        return "CAST(X'" + value.encode("utf-8").hex().upper() + "' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def real_literal(value: float) -> str:
    """An exact SQL expression for a REAL, without trusting SQLite's decimal parser.

    SQLite builds round some decimal literals differently (3.51 reads -1e-300 one unit off; 3.53 does not), so a
    real is written as its 53-bit integer mantissa times powers of two: CAST(m AS REAL) is exact, and multiplying or
    dividing by 2^62 (an integer literal) is exact at every step, since each intermediate is m * 2^k with k between
    0 and the final exponent, which is representable whenever the final value is.
    """
    if value != value:
        return "NULL"  # SQLite never stores NaN
    if value in (float("inf"), float("-inf")):
        return "9e999" if value > 0 else "-9e999"
    if value == 0:
        return "0.0"  # SQLite keeps no negative zero
    fraction, exponent = math.frexp(value)  # value = fraction * 2^exponent, 0.5 <= |fraction| < 1
    mantissa, exponent = int(fraction * 2**53), exponent - 53
    text = f"CAST({mantissa} AS REAL)"
    operator = " * " if exponent > 0 else " / "
    remaining = abs(exponent)
    while remaining:
        step = min(remaining, 62)
        text += f"{operator}{2**step}"
        remaining -= step
    return text


def literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        raise ToolError("unexpected boolean value")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return real_literal(value)
    if isinstance(value, bytes):
        return "X'" + value.hex().upper() + "'"
    if isinstance(value, str):
        return text_literal(value)
    raise ToolError(f"unexpected value type {type(value).__name__}")


def size(value: object) -> int:
    """The value's stored size in bytes, as D1 limits it."""
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, bytes):
        return len(value)
    return 8


def insert(table: str, columns: Sequence[str], values: Sequence[str]) -> str:
    return f"INSERT INTO {ident(table)} ({', '.join(map(ident, columns))}) VALUES ({', '.join(values)});"


def text_chunks(value: str, budget: int) -> Iterable[str]:
    """Consecutive pieces of `value`, cut between characters, whose literals are each about `budget` bytes.

    A value that needs hex costs two bytes per UTF-8 byte in every piece (a conservative estimate: a piece without
    a control character or keyword is written quoted).
    """
    hexed = needs_hex(value)
    piece, cost = [], 0
    for char in value:
        weight = len(char.encode("utf-8")) * (2 if hexed or char == "'" else 1)
        if piece and cost + weight > budget:
            yield "".join(piece)
            piece, cost = [], 0
        piece.append(char)
        cost += weight
    if piece:
        yield "".join(piece)


def appends(prefix: str, suffix: str, value: str) -> list[str]:
    """`prefix <literal> suffix` statements that rebuild `value`, each within STATEMENT_BUDGET bytes.

    A piece whose statement still overflows the estimate is halved.
    """
    statements = []
    pending = list(text_chunks(value, STATEMENT_BUDGET - len((prefix + suffix).encode("utf-8")) - 64))
    while pending:
        piece = pending.pop(0)
        statement = prefix + text_literal(piece) + suffix
        if len(statement.encode("utf-8")) <= STATEMENT_BUDGET:
            statements.append(statement)
        elif len(piece) > 1:
            pending[:0] = [piece[: len(piece) // 2], piece[len(piece) // 2 :]]
        else:
            raise ToolError("a character cannot be written under D1's statement limit")
    return statements


def row_statements(table: Table, columns: Sequence[str], row: Sequence[object]) -> list[str]:
    """One INSERT for the row, plus UPDATEs that append any text too long for one statement."""
    values = [literal(value) for value in row]
    statement = insert(table.name, columns, values)
    moved: list[tuple[str, str]] = []
    # Move the longest text values out of the INSERT until it fits.
    for index in sorted(range(len(row)), key=lambda i: -len(values[i])):
        if len(statement.encode("utf-8")) <= STATEMENT_BUDGET:
            break
        if not isinstance(row[index], str) or columns[index] == table.primary_key:
            raise ToolError(f"a row of {table.name} cannot be split under D1's statement limit")
        moved.append((columns[index], row[index]))
        values[index] = "''"
        statement = insert(table.name, columns, values)
    statements = [statement]
    if moved and row[columns.index(table.primary_key)] is None:
        raise ToolError(f"a row of {table.name} with a NULL primary key cannot be appended to")
    key = literal(row[columns.index(table.primary_key)])
    for column, value in moved:
        prefix = f"UPDATE {ident(table.name)} SET {ident(column)} = {ident(column)} || "
        statements.extend(appends(prefix, f" WHERE {ident(table.primary_key)} = {key};", value))
    for text in statements:
        if len(text.encode("utf-8")) > D1_MAX_STATEMENT_BYTES:
            raise ToolError(f"a statement for {table.name} exceeds D1's {D1_MAX_STATEMENT_BYTES}-byte limit")
    return statements


# --- Canonical form, identical for SQLite and D1 ------------------------------------------------------------------


def canonical_select(table: Table, columns: Sequence[str], where: str = "") -> str:
    """Each column as its type and an exact value: integers as text (JSON numbers lose precision past 2^53),
    BLOBs as hex, reals as numbers (shortest round-trip on both sides; +-Inf, which D1's JSON turns into null, as
    the text 'inf' or '-inf') and text as itself."""
    picks = []
    for i, column in enumerate(columns):
        c = ident(column)
        real = f"CASE WHEN {c} > {MAX_DOUBLE} THEN 'inf' WHEN {c} < -{MAX_DOUBLE} THEN '-inf' ELSE {c} END"
        picks.append(f"typeof({c}) AS t{i}")
        picks.append(
            f"CASE typeof({c}) WHEN 'integer' THEN CAST({c} AS TEXT) WHEN 'blob' THEN hex({c})"
            f" WHEN 'real' THEN {real} ELSE {c} END AS v{i}"
        )
    return f"SELECT {', '.join(picks)} FROM {ident(table.name)}{where} ORDER BY {ident(table.primary_key)}"


def stats_select(table: Table, columns: Sequence[str], where: str = "") -> str:
    """count(*) and the total length of each column's text and BLOB values.

    Only text and BLOBs: length() of a REAL measures its text rendering, which differs between SQLite builds (the
    local Python one and D1's), so identical reals could compare DIFFERENT. The digest compares reals exactly.
    """
    lengths = ", ".join(
        f"total(CASE WHEN typeof({ident(column)}) IN ('text', 'blob') THEN length({ident(column)}) END) AS l{i}"
        for i, column in enumerate(columns)
    )
    return f"SELECT count(*) AS n, {lengths} FROM {ident(table.name)}{where}"


def canonical_line(row: dict, width: int) -> str:
    cells = []
    for i in range(width):
        kind, value = row[f"t{i}"], row[f"v{i}"]
        if kind == "real":
            if value is None:
                raise ToolError("a REAL value came back as null")
            value = repr(float(value) + 0.0)  # + 0.0: -0.0 and 0.0 are the same SQLite value
        elif value is not None:
            value = str(value)
        cells.append([kind, value])
    return json.dumps(cells, ensure_ascii=True, separators=(",", ":"))


def digest(lines: list[str]) -> str:
    hasher = hashlib.sha256()
    for line in sorted(lines):
        hasher.update(line.encode("ascii") + b"\n")
    return hasher.hexdigest()


def summary(table: Table, columns: Sequence[str], stats: dict, rows: list[dict]) -> dict:
    return {
        "rows": int(stats["n"]),
        "lengths": {column: float(stats[f"l{i}"] or 0) for i, column in enumerate(columns)},
        "sha256": digest([canonical_line(row, len(columns)) for row in rows]),
    }


def source_filter(table: Table) -> str:
    """The rows export leaves out: only the excluded settings keys (a NULL key is kept, so it cannot hide)."""
    if table.name != "settings":
        return ""
    keys = ", ".join(text_literal(key) for key in EXCLUDED_SETTINGS)
    return f" WHERE key IS NULL OR key NOT IN ({keys})"


# --- The local copy ----------------------------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


def fingerprint(directory: Path) -> dict[str, str]:
    """Every file next to the source, by name, with its SHA-256: nothing may change or appear."""
    return {path.name: sha256_file(path) for path in sorted(directory.iterdir()) if path.is_file()}


def private_path(path: Path, what: str) -> Path:
    """`path` resolved, refused inside this (public) repository or under a cloud-synced folder of the home directory,
    where a sync client would upload the snapshot, import.sql or wrangler's log."""
    resolved = path.expanduser().resolve()
    if resolved == REPO or REPO in resolved.parents:
        raise ToolError(f"{what} must be outside the repository (it is public)")
    home = Path.home().resolve()
    for folder in CLOUD_SYNCED:
        synced = home / folder
        if resolved == synced or synced in resolved.parents:
            raise ToolError(f"{what} must not be in a cloud-synced folder (~/{folder}): use `mktemp -d`")
    return resolved


def host_hashes(path: Path) -> dict[str, str]:
    """`sha256sum` output (one `<hex>  <name>` per line) as {file name: hex}."""
    hashes = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        match = SHA256SUM_LINE.match(line.strip())
        if not match:
            raise ToolError("--expect-sha256 holds a line that is not `sha256sum` output")
        hashes[Path(match.group(2)).name] = match.group(1).lower()
    return hashes


def check_host_hashes(source: Path, copied: dict[str, str], expected: dict[str, str]) -> int:
    """The copied database files equal what the host recorded after the stop: the same files, the same bytes."""
    names = {source.name, source.name + "-wal"}
    want = {name: digest for name, digest in expected.items() if name in names}
    got = {name: digest for name, digest in copied.items() if name in names}
    if source.name not in want:
        raise ToolError(f"--expect-sha256 has no line for {source.name}")
    if set(want) != set(got):
        raise ToolError("the copied database files differ from the host's list (a -wal missing or extra)")
    if want != got:
        raise ToolError("a copied database file differs from its SHA-256 recorded on the host")
    return len(want)


def wal_frames(path: Path) -> int:
    """Frames a WAL file holds by its size (valid or not); 0 without a WAL header."""
    if not path.exists() or path.stat().st_size < 32:
        return 0
    with path.open("rb") as handle:
        magic, _version, page_size = struct.unpack(">III", handle.read(12))
    if magic not in WAL_MAGIC or page_size < 512:
        raise ToolError("the -wal file has no WAL header")
    return (path.stat().st_size - 32) // (page_size + 24)


def private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def strict_text(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ToolError("a text value is not valid UTF-8") from None


def open_snapshot(path: Path) -> sqlite3.Connection:
    """The checkpointed snapshot (no WAL left), read-only and immutable."""
    db = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    db.text_factory = strict_text
    return db


def snapshot(source: Path, workdir: Path, log: Callable[[str], None]) -> Path:
    """Copy SOURCE (+ -wal) into WORKDIR, apply the WAL to the copy and return the self-contained snapshot."""
    wal = source.with_name(source.name + "-wal")
    stage = workdir / "stage"
    private_dir(stage)
    staged = stage / "flowday.db"
    shutil.copyfile(source, staged)
    frames = 0
    if wal.exists():
        shutil.copyfile(wal, stage / "flowday.db-wal")
        frames = wal_frames(stage / "flowday.db-wal")
    for path in stage.iterdir():
        os.chmod(path, 0o600)
    db = sqlite3.connect(str(staged))
    try:
        # FULL reports the WAL's valid frames and how many reached the copy (-1, -1 when not in WAL mode);
        # journal_mode=DELETE then removes the WAL, so the snapshot is one self-contained file.
        busy, logged, checkpointed = db.execute("PRAGMA wal_checkpoint(FULL)").fetchone()
        mode = db.execute("PRAGMA journal_mode = DELETE").fetchone()[0]
        check = db.execute("PRAGMA integrity_check").fetchall()
    finally:
        db.close()
    if mode != "delete" or busy or checkpointed != logged:
        raise ToolError("could not checkpoint the staged copy")
    if check != [("ok",)]:
        raise ToolError("the staged copy fails PRAGMA integrity_check")
    applied = max(checkpointed, 0)
    log(f"WAL: {frames} frame(s) in the file, {applied} applied to the copy")
    if frames and not applied:
        raise ToolError("the -wal file holds frames but none belong to this database (a stale or torn copy)")
    snapshot_path = workdir / "snapshot.db"
    os.replace(staged, snapshot_path)
    shutil.rmtree(stage)
    os.chmod(snapshot_path, 0o600)
    return snapshot_path


def check_source_schema(db: sqlite3.Connection, expected: dict[str, Table]) -> None:
    present = {
        name
        for (name,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
        )
    }
    if present != set(expected):
        raise ToolError(
            "the source's tables differ from migration 0001: "
            f"missing {sorted(set(expected) - present)}, unknown {sorted(present - set(expected))}"
        )
    for table in expected.values():
        columns = {row[1] for row in db.execute(f"PRAGMA table_info({ident(table.name)})")}
        if columns != set(table.columns):
            raise ToolError(f"the columns of {table.name} differ from migration 0001")


def local_summaries(db: sqlite3.Connection, tables: dict[str, Table]) -> dict[str, dict]:
    db.row_factory = sqlite3.Row
    try:
        result = {}
        for table in tables.values():
            where = source_filter(table)
            stats = dict(db.execute(stats_select(table, table.columns, where)).fetchone())
            rows = [dict(row) for row in db.execute(canonical_select(table, table.columns, where))]
            result[table.name] = summary(table, table.columns, stats, rows)
        return result
    finally:
        db.row_factory = None


def export(
    source: Path,
    workdir: Path,
    max_rows_written: int,
    log: Callable[[str], None],
    expect_sha256: Path | None = None,
) -> dict:
    source = private_path(source, "--source")
    workdir = private_path(workdir, "--workdir")
    if not source.is_file():
        raise ToolError("--source is not a file")
    if source.with_name(source.name + "-journal").exists():
        raise ToolError("a rollback journal lies next to the source: the copy was taken mid-transaction")
    if workdir.exists() and any(workdir.iterdir()):
        raise ToolError("--workdir must be new or empty")
    if workdir == source.parent or source.parent in workdir.parents:
        raise ToolError("--workdir must not be next to or below the source")
    expected = host_hashes(expect_sha256) if expect_sha256 is not None else None
    private_dir(workdir)
    before = fingerprint(source.parent)
    if expected is None:
        log("Host hashes: not checked (pass --expect-sha256 with the host's `sha256sum flowday.db*` output).")
    else:
        log(f"Host hashes: {check_host_hashes(source, before, expected)} file(s) equal to the host's after the stop.")

    snapshot_path = snapshot(source, workdir, log)

    if fingerprint(source.parent) != before:
        raise ToolError("the source directory changed during the export (a file changed or appeared)")
    tables, target = source_schema(), target_schema()
    db = open_snapshot(snapshot_path)
    try:
        check_source_schema(db, tables)
        (count,) = db.execute(
            "SELECT count(*) FROM settings WHERE key IN (" + ", ".join("?" * len(WORKER_ONLY_SETTINGS)) + ")",
            WORKER_ONLY_SETTINGS,
        ).fetchone()
        if count:
            raise ToolError("the source holds settings only the Worker writes: not a container-era file")
        for table in tables.values():
            (nulls,) = db.execute(
                f"SELECT count(*) FROM {ident(table.name)} WHERE {ident(table.primary_key)} IS NULL"
            ).fetchone()
            if nulls:
                raise ToolError(f"table {table.name}: {nulls} row(s) with a NULL primary key (D1 could not match them)")
        (excluded,) = db.execute(
            "SELECT count(*) FROM settings WHERE key IN (" + ", ".join("?" * len(EXCLUDED_SETTINGS)) + ")",
            EXCLUDED_SETTINGS,
        ).fetchone()
        statements, rows_written = 0, 0
        sql_path = workdir / "import.sql"
        descriptor = os.open(sql_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as out:
            for table in tables.values():
                names = ", ".join(map(ident, table.columns))
                query = (
                    f"SELECT {names} FROM {ident(table.name)}{source_filter(table)} ORDER BY {ident(table.primary_key)}"
                )
                for row in db.execute(query):
                    if sum(size(value) for value in row) > D1_MAX_VALUE_BYTES:
                        raise ToolError(f"a row of {table.name} exceeds D1's {D1_MAX_VALUE_BYTES}-byte row limit")
                    for text in row_statements(table, table.columns, row):
                        out.write(text + "\n")
                        statements += 1
                        rows_written += 1 + target[table.name].indexes
        summaries = local_summaries(db, tables)
    finally:
        db.close()
    if rows_written > max_rows_written:
        sql_path.unlink()
        raise ToolError(
            f"the import would write about {rows_written} D1 rows, above --max-rows-written {max_rows_written}"
        )
    manifest = {
        "format": MANIFEST_FORMAT,
        "tables": summaries,
        "excluded_settings_rows": excluded,
        "statements": statements,
        "estimated_rows_written": rows_written,
        "import_sql_bytes": sql_path.stat().st_size,
        "import_sql_sha256": sha256_file(sql_path),
        "snapshot_sha256": sha256_file(snapshot_path),
    }
    write_private_json(workdir / "manifest.json", manifest)
    for name, entry in summaries.items():
        log(f"table {name}: {entry['rows']} row(s), sha256 {entry['sha256'][:12]}")
    log(f"settings rows left out: {excluded} (todoist_api_key)")
    log(
        f"import.sql: {statements} statement(s), {manifest['import_sql_bytes']} bytes, "
        f"about {rows_written} D1 rows written"
    )
    log("Source files unchanged (SHA-256 of every file before and after).")
    return manifest


def write_private_json(path: Path, value: dict) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as out:
        json.dump(value, out, indent=2, sort_keys=True)
        out.write("\n")


def read_manifest(workdir: Path) -> dict:
    path = workdir / "manifest.json"
    if not path.is_file():
        raise ToolError("--workdir has no manifest.json (run export first)")
    manifest = json.loads(path.read_text())
    if manifest.get("format") != MANIFEST_FORMAT:
        raise ToolError("manifest.json is from another version of this tool: export again into a new --workdir")
    return manifest


# --- D1 through wrangler ------------------------------------------------------------------------------------------


def wrangler_env(scratch: Path) -> dict[str, str]:
    """wrangler's environment: no metrics, no colour, non-interactive, and no debug log.

    By default wrangler appends everything it prints (a `d1 execute --json` result holds the rows read, an error may
    quote the SQL) to <its global config directory>/logs/wrangler-<time>.log, mode 0644, kept 30 days.
    WRANGLER_WRITE_LOGS=false turns that off; WRANGLER_LOG_PATH points into a directory deleted after the call in
    case a wrangler version ignores the switch.
    """
    return dict(
        os.environ,
        WRANGLER_SEND_METRICS="false",
        WRANGLER_WRITE_LOGS="false",
        WRANGLER_LOG_PATH=str(scratch / "wrangler.log"),
        NO_COLOR="1",
        CI=os.environ.get("CI", "1"),
    )


class D1:
    """The D1 database "flowday" through the pinned wrangler: --remote, or --local with its own persistence dir."""

    def __init__(self, remote: bool, persist_to: Path | None, log_path: Path | None = None):
        if remote == (persist_to is not None):
            raise ToolError("use exactly one of --remote and --local --persist-to DIR")
        self.remote = remote
        self.persist_to = persist_to
        self.log_path = log_path

    @staticmethod
    def binary() -> str:
        """The pinned wrangler (FLOWDAY_WRANGLER replaces it in tests)."""
        override = os.environ.get("FLOWDAY_WRANGLER")
        if override:
            return override
        pinned = WORKER / "node_modules" / ".bin" / "wrangler"
        if not pinned.exists():
            raise ToolError("wrangler is not installed: run `npm ci` in flowday/worker")
        return str(pinned)

    def execute(self, *args: str) -> list[str]:
        """`wrangler d1 execute DB` against this target."""
        location = ["--remote"] if self.remote else ["--local", "--persist-to", str(self.persist_to)]
        return [self.binary(), "d1", "execute", BINDING, *location, "--config", str(CONFIG), *args]

    def run(self, argv: list[str], what: str) -> str:
        with tempfile.TemporaryDirectory(prefix="flowday-wrangler-") as scratch:
            done = subprocess.run(
                argv,
                cwd=WORKER,
                env=wrangler_env(Path(scratch)),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
            )
        if self.log_path is not None:
            descriptor = os.open(self.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, "a") as out:
                out.write(f"$ wrangler {what} (exit {done.returncode})\n{done.stdout}\n{done.stderr}\n")
        if done.returncode != 0:
            raise ToolError(
                f"wrangler {what} failed (exit {done.returncode}); its output is not printed"
                + (f", see {self.log_path}" if self.log_path else "")
            )
        return done.stdout

    def query(self, statements: Sequence[str]) -> list[list[dict]]:
        """Read-only SELECTs (and PRAGMA table_info), one result list per statement."""
        for statement in statements:
            if not READ_ONLY.match(statement) or ";" in statement:
                raise ToolError("D1 reads are SELECT or PRAGMA table_info statements only")
        output = self.run(self.execute("--json", "--command", "; ".join(statements)), "d1 execute --command")
        try:
            results = json.loads(output)
        except ValueError:
            raise ToolError("wrangler did not answer with JSON") from None
        if (
            not isinstance(results, list)
            or len(results) != len(statements)
            or not all(r.get("success") for r in results)
        ):
            raise ToolError("wrangler's answer does not match the statements")
        return [list(result.get("results") or []) for result in results]

    def execute_file(self, path: Path) -> dict:
        """Run a SQL file; wrangler applies a --remote file atomically. Returns its counts (no content)."""
        output = self.run(self.execute("--json", "--yes", "--file", str(path)), "d1 execute --file")
        try:
            results = json.loads(output)
        except ValueError:
            raise ToolError("wrangler did not answer with JSON") from None
        if not isinstance(results, list) or not all(r.get("success") for r in results):
            raise ToolError("wrangler reported a failed statement")
        if self.remote:
            counts = results[0]["results"][0]
            return {"queries": counts.get("Total queries executed"), "rows_written": counts.get("Rows written")}
        return {"queries": len(results), "rows_written": None}

    def restore(self, bookmark: str) -> None:
        if not self.remote:
            raise ToolError("Time Travel exists only for the remote D1")
        argv = [
            self.binary(),
            "d1",
            "time-travel",
            "restore",
            BINDING,
            "--bookmark",
            bookmark,
            "--json",
            "--config",
            str(CONFIG),
        ]
        self.run(argv, "d1 time-travel restore")


def d1_from(args: argparse.Namespace, log_path: Path | None = None) -> D1:
    persist = Path(args.persist_to).resolve() if args.local else None
    if args.local and args.persist_to is None:
        raise ToolError("--local needs --persist-to DIR (never the development database by accident)")
    return D1(args.remote, persist, log_path)


def user_tables(rows: list[dict]) -> set[str]:
    return {
        row["name"]
        for row in rows
        if not row["name"].startswith(("sqlite_", "_cf_")) and row["name"] != "d1_migrations"
    }


def check_empty(d1: D1, log: Callable[[str], None]) -> None:
    """The committed schema, every committed migration applied, and not one row in any table (two reads)."""
    target = target_schema()
    tables, applied, *infos = d1.query(
        ["SELECT name FROM sqlite_master WHERE type = 'table'", "SELECT name FROM d1_migrations ORDER BY id"]
        + [f"PRAGMA table_info({ident(name)})" for name in target]
    )
    if user_tables(tables) != set(target):
        raise Failure("D1's tables differ from the committed migrations")
    if [row["name"] for row in applied] != [path.name for path in migration_files()]:
        raise Failure("D1's applied migrations differ from the committed ones (pending or unknown migrations)")
    for table, info in zip(target.values(), infos):
        if tuple(row["name"] for row in info) != table.columns:
            raise Failure(f"D1's columns of {table.name} differ from the committed migrations")
    total = 0
    for name, [row] in zip(target, d1.query([f"SELECT count(*) AS n FROM {ident(name)}" for name in target])):
        log(f"table {name}: {row['n']} row(s)")
        total += int(row["n"])
    if total:
        raise Failure(f"D1 is not empty ({total} row(s)); reset it first")
    log(f"D1 is empty: {len(target)} tables, {len(applied)} migrations applied.")


def utc_day() -> str:
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


def reserve_writes(workdir: Path, rows: int, cap: int, what: str, log: Callable[[str], None]) -> None:
    """Record `rows` estimated D1 rows written for today (UTC) in WORKDIR's ledger, or refuse above `cap`.

    Recorded before the write and never taken back: a failed (atomic) import may still have cost writes. The ledger
    knows only this work directory; other apps share the account's 100,000 rows per day too.
    """
    path = workdir / LEDGER
    ledger = json.loads(path.read_text()) if path.is_file() else {}
    day = utc_day()
    spent = int(ledger.get(day, 0))
    if spent + rows > cap:
        raise ToolError(
            f"{what} would write about {rows} D1 rows; this work directory already wrote about {spent} today (UTC),"
            f" above --max-rows-written-per-day {cap}: wait for the next UTC day (or restore a Time Travel bookmark,"
            " which this tool does not count)"
        )
    ledger[day] = spent + rows
    write_private_json(path, ledger)
    log(f"D1 rows written today (UTC) by this work directory: about {spent} + {rows} of {cap}.")


def import_file(workdir: Path, d1: D1, max_per_day: int, log: Callable[[str], None]) -> None:
    manifest = read_manifest(workdir)
    sql_path = workdir / "import.sql"
    if sha256_file(sql_path) != manifest["import_sql_sha256"]:
        raise ToolError("import.sql differs from the one export wrote")
    check_empty(d1, log)
    reserve_writes(workdir, int(manifest["estimated_rows_written"]), max_per_day, "the import", log)
    counts = d1.execute_file(sql_path)
    log(
        f"Imported: {counts['queries']} statement(s) executed"
        + (f", {counts['rows_written']} rows written" if counts["rows_written"] is not None else "")
    )


def d1_summaries(d1: D1, tables: dict[str, Table], checks: Sequence[str]) -> tuple[dict[str, dict], list[list[dict]]]:
    """Every table's summary read from D1, plus the answers to `checks` (read with the statistics)."""
    answers = d1.query([stats_select(table, table.columns) for table in tables.values()] + list(checks))
    stats = {name: rows[0] for name, rows in zip(tables, answers)}
    pages = [
        (table.name, f"{canonical_select(table, table.columns)} LIMIT {PAGE_ROWS} OFFSET {first}")
        for table in tables.values()
        for first in range(0, int(stats[table.name]["n"]), PAGE_ROWS)
    ]
    rows: dict[str, list[dict]] = {name: [] for name in tables}
    for start in range(0, len(pages), PAGES_PER_CALL):
        batch = pages[start : start + PAGES_PER_CALL]
        for (name, _), page in zip(batch, d1.query([statement for _, statement in batch])):
            rows[name].extend(page)
    summaries = {
        table.name: summary(table, table.columns, stats[table.name], rows[table.name]) for table in tables.values()
    }
    return summaries, answers[len(tables) :]


def compare(name: str, want: dict, got: dict, log: Callable[[str], None]) -> bool:
    rows = want["rows"] == got["rows"]
    lengths = want["lengths"] == got["lengths"]
    digests = want["sha256"] == got["sha256"]
    word = lambda ok: "equal" if ok else "DIFFERENT"  # noqa: E731
    log(f"table {name}: rows {want['rows']} / {got['rows']}, column lengths {word(lengths)}, sha256 {word(digests)}")
    return rows and lengths and digests


def verify(workdir: Path, d1: D1, log: Callable[[str], None]) -> None:
    manifest = read_manifest(workdir)
    snapshot_path = workdir / "snapshot.db"
    if sha256_file(snapshot_path) != manifest["snapshot_sha256"]:
        raise ToolError("snapshot.db differs from the one export wrote")
    tables, target = source_schema(), target_schema()
    db = open_snapshot(snapshot_path)
    try:
        again = local_summaries(db, tables)
    finally:
        db.close()
    if again != manifest["tables"]:
        raise Failure("the snapshot no longer matches the manifest")
    keys = ", ".join(text_literal(key) for key in EXCLUDED_SETTINGS)
    extra = [(name, column) for name in tables for column in target[name].columns if column not in tables[name].columns]
    checks = [f"SELECT count(*) AS n FROM settings WHERE key IN ({keys})"]
    checks += [f"SELECT count(*) AS n FROM {ident(name)} WHERE {ident(column)} IS NOT NULL" for name, column in extra]
    remote, answers = d1_summaries(d1, tables, checks)
    ok = all([compare(name, manifest["tables"][name], remote[name], log) for name in tables])
    if answers[0][0]["n"]:
        log("settings: a todoist_api_key row exists in D1")
        ok = False
    for (name, column), [row] in zip(extra, answers[1:]):
        if row["n"]:
            log(f"table {name}: {row['n']} row(s) with the D1-only column {column} set")
            ok = False
    if not ok:
        raise Failure("D1 differs from the snapshot")
    log(f"D1 equals the snapshot: {len(tables)} tables, no todoist_api_key row, D1-only columns empty.")


def reset(
    d1: D1,
    delete_all_rows: bool,
    bookmark_env: str | None,
    workdir: Path | None,
    max_per_day: int,
    log: Callable[[str], None],
) -> None:
    if delete_all_rows == (bookmark_env is not None):
        raise ToolError("use exactly one of --delete-all-rows and --bookmark-env NAME")
    if bookmark_env is not None:
        bookmark = os.environ.get(bookmark_env, "")
        if not re.fullmatch(r"[0-9a-f-]{16,}", bookmark):
            raise ToolError(f"{bookmark_env} does not hold a D1 bookmark")
        d1.restore(bookmark)
        log("Restored the Time Travel bookmark.")
    else:
        if workdir is None:
            raise ToolError("--delete-all-rows needs --workdir (its ledger of today's D1 rows written)")
        if not workdir.is_dir():
            raise ToolError("--workdir is not a directory")
        target = target_schema()
        counts = d1.query([f"SELECT count(*) AS n FROM {ident(name)}" for name in target])
        rows = 0
        for table, [row] in zip(target.values(), counts):
            log(f"table {table.name}: {row['n']} row(s) before the reset")
            rows += int(row["n"]) * (1 + table.indexes)  # a deleted row also deletes its index entries
        reserve_writes(workdir, rows, max_per_day, "the reset", log)
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "reset.sql"
            path.write_text("".join(f"DELETE FROM {ident(name)};\n" for name in target))
            d1.execute_file(path)
        log("Deleted every row of the FlowDay tables (d1_migrations kept).")
    check_empty(d1, log)


# --- Command line ---------------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = root.add_subparsers(dest="command", required=True)

    def d1_options(command: argparse.ArgumentParser) -> None:
        where = command.add_mutually_exclusive_group(required=True)
        where.add_argument("--remote", action="store_true", help="the production D1 (wrangler's auth)")
        where.add_argument("--local", action="store_true", help="a local D1 (needs --persist-to)")
        command.add_argument("--persist-to", help="the local D1's persistence directory")

    def budget(command: argparse.ArgumentParser) -> None:
        command.add_argument(
            "--max-rows-written-per-day",
            type=int,
            default=DEFAULT_MAX_ROWS_WRITTEN,
            help="estimated D1 rows this work directory may write per UTC day (import and --delete-all-rows)",
        )

    command = commands.add_parser("export", help="snapshot the local copy and write import.sql and manifest.json")
    command.add_argument("--source", required=True, help="the local copy of flowday.db (its -wal next to it)")
    command.add_argument("--workdir", required=True, help="a new private local directory (`mktemp -d`)")
    command.add_argument("--max-rows-written", type=int, default=DEFAULT_MAX_ROWS_WRITTEN)
    command.add_argument("--expect-sha256", help="the host's `sha256sum flowday.db*` output, taken after the stop")

    d1_options(commands.add_parser("check-empty", help="refuse unless D1 has the schema and no row"))
    command = commands.add_parser("import", help="check-empty, then import import.sql")
    command.add_argument("--workdir", required=True)
    d1_options(command)
    budget(command)
    command = commands.add_parser("verify", help="compare D1 with the snapshot")
    command.add_argument("--workdir", required=True)
    d1_options(command)
    command = commands.add_parser("reset", help="empty D1 again: restore a Time Travel bookmark, or delete every row")
    d1_options(command)
    command.add_argument("--bookmark-env", help="the environment variable that holds the bookmark")
    command.add_argument("--delete-all-rows", action="store_true")
    command.add_argument("--workdir", help="for --delete-all-rows: the work directory whose write ledger it uses")
    budget(command)
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    log = lambda line: print(line, flush=True)  # noqa: E731
    try:
        if args.command == "export":
            expect = Path(args.expect_sha256) if args.expect_sha256 else None
            export(Path(args.source), Path(args.workdir), args.max_rows_written, log, expect)
            log("Keep WORKDIR private; delete it after verify.")
        elif args.command == "check-empty":
            check_empty(d1_from(args), log)
        elif args.command == "import":
            workdir = private_path(Path(args.workdir), "--workdir")
            d1 = d1_from(args, workdir / "wrangler-import.log")
            import_file(workdir, d1, args.max_rows_written_per_day, log)
        elif args.command == "verify":
            verify(private_path(Path(args.workdir), "--workdir"), d1_from(args), log)
        elif args.command == "reset":
            workdir = private_path(Path(args.workdir), "--workdir") if args.workdir else None
            reset(d1_from(args), args.delete_all_rows, args.bookmark_env, workdir, args.max_rows_written_per_day, log)
    except Failure as failure:
        print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    except ToolError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    except (sqlite3.Error, OSError) as error:
        # Neither names a row's content: SQLite errors name objects, OS errors name paths.
        print(f"ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
