#!/usr/bin/env python3
"""Restore a weekly Todofy D1 backup (worker/todofy/runtime/backup.py) into an empty D1 database.

  download  fetch a backup's manifest and parts from R2 with `wrangler r2 object get`; check every
            part's SHA-256 and row count
  sql       write one SQL file that loads the downloaded rows into a D1 database with the
            migrations applied and no rows (checked again against the manifest first)
  verify    compare the restored database's row counts with the manifest and check that the
            backup's migration is applied (later, additive migrations are fine)

  python3 tools/backup_restore.py download --backup backups/2026-10-04T100000Z --out restore/ --remote
  python3 tools/backup_restore.py sql --in restore/ --out restore/restore.sql
  npx wrangler d1 migrations apply DB --remote --config <new database's config>
  npx wrangler d1 execute DB --remote --config <new database's config> --file restore/restore.sql
  python3 tools/backup_restore.py verify --in restore/ --db DB --remote --config <new database's config>

Local dev and tests use `--local --persist-to <dir>` in place of `--remote`. Every statement is an
``INSERT ... ON CONFLICT DO NOTHING`` below D1's 100 KB statement limit; longer values are appended
by UPDATEs guarded on the current byte length, so re-running the file after a partial run is safe.
The files hold mail content: they are written owner-only, and row contents are never printed.
Stdlib only; runs on Python 3.9+.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shlex
import subprocess
import sys
import zlib
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

WEEKLY_FORMAT = "todofy-d1-backup-v1"
DEFAULT_BUCKET = "todofy-backups"
MANIFEST = "manifest.json"
LEGACY_TEXT = "legacy_mail_text"
PARTS = "parts"
MAX_STATEMENT_BYTES = 90_000
CHUNK_BYTES = 80_000
# Values up to this long always stay in the INSERT; longer ones may be appended.
LONG_VALUE_BYTES = 4_000


class RestoreError(Exception):
    """A backup that does not match its manifest, or a failed command; never contains row content."""


def _private_opener(path: str, flags: int) -> int:
    return os.open(path, flags, 0o600)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Wrangler:
    """`wrangler` with the target flags (--remote, or --local with --persist-to) and an optional config."""

    def __init__(self, command: str, target: Sequence[str]) -> None:
        self.command = shlex.split(command)
        self.target = list(target)

    def run(self, *args: str) -> str:
        completed = subprocess.run(
            [*self.command, *args, *self.target],
            capture_output=True,
            text=True,
            env={**os.environ, "CI": "true", "WRANGLER_SEND_METRICS": "false"},
        )
        if completed.returncode != 0:
            # stderr carries wrangler's own error, not row data.
            raise RestoreError(f"wrangler {args[0]} {args[1]} failed: {completed.stderr.strip()[-2000:]}")
        return completed.stdout

    def get(self, bucket: str, key: str, path: Path) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.run("r2", "object", "get", f"{bucket}/{key}", "--file", str(path))
        path.chmod(0o600)

    def query(self, db: str, sql: str) -> list[dict[str, Any]]:
        results = json.loads(self.run("d1", "execute", db, "--json", "--command", sql))
        if not isinstance(results, list) or len(results) != 1 or not results[0].get("success", False):
            raise RestoreError("wrangler returned an unexpected result shape")
        return results[0]["results"]


# ---------------------------------------------------------------- manifests and parts


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(path.read_bytes())
    except (OSError, ValueError):
        raise RestoreError(f"{path.name}: missing or not JSON") from None
    if document.get("format") != WEEKLY_FORMAT:
        raise RestoreError(f"{path.name}: format is not {WEEKLY_FORMAT}")
    return document


def _part_path(root: Path, key: str) -> Path:
    if key.startswith("/") or ".." in key.split("/"):
        raise RestoreError("a part key leaves the download directory")
    return root / PARTS / key


def part_rows(path: Path, width: int) -> Iterator[list[Any]]:
    """The rows of one gzip NDJSON part, each checked to have ``width`` values."""
    try:
        with gzip.open(path, "rt", encoding="utf-8") as lines:
            for line in lines:
                row = json.loads(line)
                if not isinstance(row, list) or len(row) != width:
                    raise RestoreError(f"{path.name}: a row does not match the manifest's columns")
                yield row
    except (OSError, EOFError, ValueError, zlib.error):
        raise RestoreError(f"{path.name}: not a readable gzip NDJSON part") from None


def check_table(root: Path, table: dict[str, Any]) -> None:
    """Every part is present with the manifest's SHA-256 and row count, and the counts add up."""
    width, total = len(table["columns"]), 0
    for part in table["parts"]:
        path = _part_path(root, part["key"])
        if not path.is_file() or _sha256(path) != part["sha256"]:
            raise RestoreError(f"{part['key']}: missing or SHA-256 differs from the manifest")
        rows = sum(1 for _ in part_rows(path, width))
        if rows != part["rows"]:
            raise RestoreError(f"{part['key']}: {rows} rows, manifest says {part['rows']}")
        total += rows
    if total != table["rows"]:
        raise RestoreError(f"{table['name']}: parts hold {total} rows, manifest says {table['rows']}")


def _tables(manifest: dict[str, Any], *, legacy_text: bool) -> list[dict[str, Any]]:
    """The manifest's tables to restore: all of them, or all but the imported mail text."""
    return [table for table in manifest["tables"] if legacy_text or table["name"] != LEGACY_TEXT]


def load_tables(root: Path, *, legacy_text: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The manifest and every table to restore, all parts checked."""
    manifest = _read_manifest(root / MANIFEST)
    tables = _tables(manifest, legacy_text=legacy_text)
    for table in tables:
        check_table(root, table)
    return manifest, tables


def download(wrangler: Wrangler, bucket: str, backup: str, root: Path, *, legacy_text: bool) -> list[str]:
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    wrangler.get(bucket, f"{backup.rstrip('/')}/{MANIFEST}", root / MANIFEST)
    for table in _tables(_read_manifest(root / MANIFEST), legacy_text=legacy_text):
        for part in table["parts"]:
            wrangler.get(bucket, part["key"], _part_path(root, part["key"]))
    _, tables = load_tables(root, legacy_text=legacy_text)
    return [f"PASS {table['name']} rows={table['rows']} parts={len(table['parts'])}" for table in tables]


# ---------------------------------------------------------------- SQL output


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise RestoreError(f"unsupported value type {type(value).__name__}")
    if isinstance(value, int):
        return str(value)
    if "\x00" in value:
        # A NUL would end the statement in SQLite's tokenizer; a blob cast keeps it.
        return f"CAST(X'{value.encode().hex()}' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def _utf8_len(value: str) -> int:
    return len(value.encode())


def _split_literal(value: str, budget: int) -> Iterator[str]:
    """Consecutive pieces of ``value`` whose SQL literals fit ``budget`` bytes."""
    hexed = "\x00" in value  # any piece may then need the hex form: budget for it
    overhead = len("CAST(X'' AS TEXT)") if hexed else 2
    start, used = 0, overhead
    for index, char in enumerate(value):
        cost = 2 * _utf8_len(char) if hexed else 2 if char == "'" else _utf8_len(char)
        if used + cost > budget and index > start:
            yield value[start:index]
            start, used = index, overhead
        used += cost
    yield value[start:]


def row_statements(table: dict[str, Any], row: Sequence[Any]) -> list[str]:
    """INSERT for one row, plus length-guarded appends of its long values when it is too long."""
    name, columns, key = table["name"], table["columns"], table["key"]
    names = ", ".join(columns)

    def insert(values: Sequence[Any]) -> str:
        return (
            f"INSERT INTO {name} ({names}) VALUES ({', '.join(sql_literal(v) for v in values)}) ON CONFLICT DO NOTHING;"
        )

    statement = insert(row)
    if _utf8_len(statement) <= MAX_STATEMENT_BYTES:
        return [statement]
    long = [i for i, value in enumerate(row) if isinstance(value, str) and _utf8_len(value) > LONG_VALUE_BYTES]
    if any(columns[i] in key for i in long):
        raise RestoreError(f"{name}: a key value exceeds the statement limit")
    statements = [insert(["" if i in long else value for i, value in enumerate(row)])]
    if _utf8_len(statements[0]) > MAX_STATEMENT_BYTES:
        raise RestoreError(f"{name}: a row's short values exceed the statement limit")
    where = " AND ".join(f"{column} = {sql_literal(row[columns.index(column)])}" for column in key)
    for i in long:
        column, done = columns[i], 0
        for piece in _split_literal(row[i], CHUNK_BYTES):
            # The guard makes a re-run a no-op and lets a partial run resume in order.
            statements.append(
                f"UPDATE {name} SET {column} = {column} || {sql_literal(piece)}"
                f" WHERE {where} AND length(CAST({column} AS BLOB)) = {done};"
            )
            done += _utf8_len(piece)
    return statements


def write_sql(root: Path, out: Path, *, legacy_text: bool) -> list[str]:
    manifest, tables = load_tables(root, legacy_text=legacy_text)
    lines = []
    with open(out, "w", encoding="utf-8", newline="\n", opener=_private_opener) as sql:
        sql.write(
            f"-- Todofy D1 restore from {WEEKLY_FORMAT} created {manifest['created_at']}, schema"
            f" {manifest['schema_version']}. Load into a database with that migration (or a later, additive one)"
            " applied and no rows.\n"
        )
        for table in tables:
            statements = 0
            for part in table["parts"]:
                for row in part_rows(_part_path(root, part["key"]), len(table["columns"])):
                    for statement in row_statements(table, row):
                        sql.write(statement + "\n")
                        statements += 1
            lines.append(f"PASS {table['name']} rows={table['rows']} statements={statements}")
    return lines


# ---------------------------------------------------------------- verification


def verify(wrangler: Wrangler, db: str, root: Path, *, legacy_text: bool) -> tuple[bool, list[str]]:
    manifest, tables = load_tables(root, legacy_text=legacy_text)
    applied = [row["name"] for row in wrangler.query(db, "SELECT name FROM d1_migrations ORDER BY id")]
    version = manifest["schema_version"]
    # The restore SQL names its columns and migrations are additive, so a newer schema loads an older
    # backup; a schema older than the backup's does not.
    ok = version in applied
    if not ok:
        note = " (not applied)"
    elif later := applied[applied.index(version) + 1 :]:
        note = f" (later migrations applied: {', '.join(later)})"
    else:
        note = ""
    lines = [f"{'PASS' if ok else 'FAIL'} schema_version {version}{note}"]
    counts = ", ".join(f"(SELECT count(*) FROM {table['name']}) AS {table['name']}" for table in tables)
    [found] = wrangler.query(db, f"SELECT {counts}")
    for table in tables:
        matches = found[table["name"]] == table["rows"]
        ok &= matches
        lines.append(f"{'PASS' if matches else 'FAIL'} {table['name']} rows={found[table['name']]}/{table['rows']}")
    return ok, lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    def target(command: argparse.ArgumentParser) -> None:
        where = command.add_mutually_exclusive_group(required=True)
        where.add_argument("--remote", action="store_true", help="the Cloudflare account")
        where.add_argument("--local", action="store_true", help="wrangler's local storage")
        command.add_argument("--persist-to", help="local storage directory (with --local)")
        command.add_argument("--config", help="a wrangler config (verify: the one naming the restored database)")
        command.add_argument("--wrangler", default="npx --no-install wrangler", help="how to run wrangler")

    for name in ("download", "sql", "verify"):
        command = commands.add_parser(name)
        command.add_argument(
            "--no-legacy-text", dest="legacy_text", action="store_false", help="leave the imported mail text out"
        )
        if name == "download":
            command.add_argument("--backup", required=True, help="the backup's prefix, e.g. backups/2026-10-04T100000Z")
            command.add_argument("--bucket", default=DEFAULT_BUCKET)
            command.add_argument("--out", type=Path, required=True, help="download directory")
        else:
            command.add_argument("--in", dest="root", type=Path, required=True, help="the download directory")
        if name == "sql":
            command.add_argument("--out", type=Path, required=True, help="the SQL file to write")
        if name == "verify":
            command.add_argument("--db", default="DB", help="D1 binding or database name")
        if name != "sql":
            target(command)
    args = parser.parse_args(argv)
    try:
        if args.command == "sql":
            lines, ok = write_sql(args.root, args.out, legacy_text=args.legacy_text), True
        else:
            flags = ["--remote"] if args.remote else ["--local"]
            flags += [f"--persist-to={args.persist_to}"] if args.persist_to else []
            flags += [f"--config={args.config}"] if args.config else []
            wrangler = Wrangler(args.wrangler, flags)
            if args.command == "download":
                lines, ok = download(wrangler, args.bucket, args.backup, args.out, legacy_text=args.legacy_text), True
            else:
                ok, lines = verify(wrangler, args.db, args.root, legacy_text=args.legacy_text)
    except RestoreError as error:
        print(f"{args.command} FAIL: {error}", file=sys.stderr)
        return 1
    for line in lines:
        print(line)
    print(f"{args.command} {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
