"""The pure parts of the weekly D1 -> R2 backup (runtime/backup.py runs it).

Layout in the private bucket (tools/backup_restore.py reads it back):

    backups/<job start>/manifest.json                written last: a prefix without it is incomplete
    backups/<job start>/<table>/<seq:05d>.ndjson.gz  one gzip part per table and alarm invocation

``<job start>`` is the UTC second the job started (``2026-10-04T100000Z``), so every
job has its own prefix and never touches an earlier backup; only retention deletes
old ones. A part holds one JSON array per row, values in the manifest's column
order. The manifest lists every table (all of them, every time) and every part
with its row count, byte size and SHA-256.
"""

import hashlib
import json
import zlib
from collections.abc import Callable, Iterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

WEEKLY_FORMAT = "todofy-d1-backup-v1"
WEEKLY_ROOT = "backups/"
MANIFEST = "manifest.json"
KEEP_WEEKLY = 6
RUN_WEEKDAY = 6  # Sunday (datetime.weekday)
RUN_HOUR = 10  # UTC
GZIP = 31  # zlib wbits for a gzip container


TIMESTAMP = "%Y-%m-%dT%H:%M:%SZ"


def timestamp(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime(TIMESTAMP)


def next_run(now: int, *, skip_today: bool = False) -> int:
    """The first Sunday 10:00 UTC strictly after ``now``; with ``skip_today`` (after a backup), not on
    ``now``'s UTC day, so a backup that finished early on a Sunday is not repeated hours later."""
    today = datetime.fromtimestamp(now, UTC).replace(hour=RUN_HOUR, minute=0, second=0, microsecond=0)
    at = today + timedelta(days=(RUN_WEEKDAY - today.weekday()) % 7)
    if at.timestamp() <= now or (skip_today and at == today):
        at += timedelta(days=7)
    return int(at.timestamp())


def weekly_prefix(now: int) -> str:
    return f"{WEEKLY_ROOT}{datetime.fromtimestamp(now, UTC):%Y-%m-%dT%H%M%SZ}/"


def part_key(prefix: str, table: str, seq: int) -> str:
    return f"{prefix}{table}/{seq:05d}.ndjson.gz"


def expired_prefixes(prefixes: Sequence[str], complete: set[str], current: str) -> list[str]:
    """Weekly prefixes to delete once ``current`` is complete: every complete one but the newest
    KEEP_WEEKLY (``current`` counts), and every incomplete one older than ``current``."""
    older = sorted((prefix for prefix in prefixes if prefix < current), reverse=True)
    kept = [prefix for prefix in older if prefix in complete][: KEEP_WEEKLY - 1]
    return sorted(prefix for prefix in older if prefix not in kept)


def slices[T](rows: Sequence[T], flagged: Callable[[T], bool], limit: int) -> Iterator[Sequence[T]]:
    """Consecutive runs of ``rows`` with at most ``limit`` flagged rows each."""
    start = count = 0
    for index, row in enumerate(rows):
        if flagged(row):
            if count == limit:
                yield rows[start:index]
                start, count = index, 0
            count += 1
    if start < len(rows):
        yield rows[start:]


class Part:
    """One gzip NDJSON part, compressed as rows arrive (the raw lines are never kept)."""

    def __init__(self) -> None:
        self._compressor = zlib.compressobj(6, zlib.DEFLATED, GZIP)
        self._chunks: list[bytes] = []
        self.rows = 0
        self.raw_bytes = 0

    def add(self, values: Sequence[Any]) -> None:
        line = json.dumps(list(values), ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        self.raw_bytes += len(line)
        self.rows += 1
        if chunk := self._compressor.compress(line):
            self._chunks.append(chunk)

    def finish(self) -> tuple[bytes, str]:
        """The gzip bytes (joined once) and their SHA-256."""
        self._chunks.append(self._compressor.flush())
        data = b"".join(self._chunks)
        self._chunks = []
        return data, hashlib.sha256(data).hexdigest()


def table_entry(name: str, columns: Sequence[str], key: Sequence[str], max_rowid: int, parts: list[dict]) -> dict:
    return {
        "name": name,
        "columns": list(columns),
        "key": list(key),
        "max_rowid": max_rowid,
        "rows": sum(part["rows"] for part in parts),
        "bytes": sum(part["bytes"] for part in parts),
        "parts": parts,
    }


def manifest(*, started_at: int, finished_at: int, schema_version: str, tables: list[dict]) -> bytes:
    document = {
        "format": WEEKLY_FORMAT,
        "started_at": timestamp(started_at),
        "created_at": timestamp(finished_at),
        "schema_version": schema_version,
        # Rows with rowid <= max_rowid when the job started; nothing newer.
        "tables": tables,
    }
    return json.dumps(document, ensure_ascii=False, indent=1).encode()
