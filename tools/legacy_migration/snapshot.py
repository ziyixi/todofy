#!/usr/bin/env python3
"""Snapshot the retired Go service's SQLite files for the export (cutover step C5).

The inbox runs in WAL mode and the Go binary does not checkpoint when it is
stopped, so the main file alone can miss committed ledger rows: never ``cp``
it. This uses SQLite's online backup API, which reads through the WAL, then
switches each copy to rollback-journal mode so it opens read-only on any SQLite
build. It prints each copy's SHA-256 and row counts (compare the inbox state
counts with step C3); row contents are never printed. Stdlib only; runs on
Python 3.9+ (no sqlite3 command-line tool needed).

    sudo python3 snapshot.py --inbox ./data/todofy-mail/inbox.sqlite \\
        --legacy ./data/todofy/todofy.db --out /root/mig/snap
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

COPIES = (("inbox", "inbox.sqlite"), ("legacy", "todofy.db"))


def snapshot(source: Path, target: Path) -> None:
    """A consistent copy of ``source`` (WAL included) at ``target``, owner-only."""
    if not source.is_file():
        raise FileNotFoundError(f"source database not found: {source}")
    src = sqlite3.connect(f"file:{quote(str(source.resolve()))}?mode=ro", uri=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)  # the copy holds mail content
    os.close(fd)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
        # A WAL-mode copy fails to open with ?mode=ro on some SQLite builds (e.g. Apple's).
        dst.execute("PRAGMA journal_mode=DELETE").fetchone()
        dst.commit()
    finally:
        dst.close()
        src.close()


def counts(path: Path) -> dict[str, object]:
    db = sqlite3.connect(f"file:{quote(str(path.resolve()))}?mode=ro", uri=True)
    try:
        tables = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        result: dict[str, object] = {}
        if "mail_inbox_events" in tables:
            rows = db.execute("SELECT state, count(*) FROM mail_inbox_events GROUP BY state ORDER BY state")
            result["state_counts"] = dict(rows.fetchall())
        for table in ("mail_inbox_reminders", "database_entries"):
            if table in tables:
                result[table] = db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        return result
    finally:
        db.close()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--inbox", type=Path, required=True, help="the live inbox.sqlite (old stack stopped)")
    parser.add_argument("--legacy", type=Path, required=True, help="the live todofy.db")
    parser.add_argument("--out", type=Path, required=True, help="new or empty directory for the copies")
    args = parser.parse_args(argv)
    if args.out.exists() and any(args.out.iterdir()):
        print(f"snapshot FAIL: output directory is not empty: {args.out}", file=sys.stderr)
        return 2
    args.out.mkdir(mode=0o700, parents=True, exist_ok=True)
    report: dict[str, object] = {}
    try:
        for name, file in COPIES:
            target = args.out / file
            snapshot(getattr(args, name), target)
            report[file] = {"sha256": sha256(target), **counts(target)}
    except (OSError, sqlite3.Error) as error:
        print(f"snapshot FAIL: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
