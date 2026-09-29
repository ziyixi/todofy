#!/usr/bin/env python3
"""Check an imported D1 database against legacy_to_d1.py's manifest.

Reads back every row the export owns through ``wrangler d1 execute --json``
(keyset pages bounded by bytes, so full mail text never lands in one response),
recomputes each table's normalized SHA-256 and compares it, the row count and
the ledger state counts with manifest.json. Prints PASS/FAIL per table and
never prints row content. Stdlib only; runs on Python 3.9+ next to
legacy_to_d1.py.

  python3 verify_d1.py --manifest out/manifest.json --remote --db todofy
  python3 verify_d1.py --manifest out/manifest.json --local --persist-to .wrangler/state --config wrangler.toml
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from legacy_to_d1 import FORMAT, LEDGER, TABLES, TableSpec, sql_literal, table_digest

Query = Callable[[str], "list[dict[str, Any]]"]

PAGE_ROWS = 500
PAGE_BYTES = 2_000_000


class VerifyError(Exception):
    pass


def wrangler_query(command: Sequence[str], db: str, target: Sequence[str]) -> Query:
    """A query function running one statement through ``wrangler d1 execute --json``."""

    def run(sql: str) -> list[dict[str, Any]]:
        completed = subprocess.run(
            [*command, "d1", "execute", db, *target, "--json", "--command", sql],
            capture_output=True,
            text=True,
            env={**os.environ, "CI": "true", "WRANGLER_SEND_METRICS": "false"},
        )
        if completed.returncode != 0:
            # stderr carries wrangler's own error, not row data.
            raise VerifyError(f"wrangler failed ({completed.returncode}): {completed.stderr.strip()[-2000:]}")
        try:
            results = json.loads(completed.stdout)
        except ValueError:
            raise VerifyError("wrangler did not return JSON") from None
        if not isinstance(results, list) or len(results) != 1 or not results[0].get("success", False):
            raise VerifyError("wrangler returned an unexpected result shape")
        return results[0]["results"]

    return run


def _after(spec: TableSpec, last: tuple[Any, ...] | None) -> str:
    if last is None:
        return ""
    names = ", ".join(spec.key)
    values = ", ".join(sql_literal(value) for value in last)
    return f" AND ({names}) > ({values})" if len(spec.key) > 1 else f" AND {names} > {values}"


def _row_bytes(spec: TableSpec) -> str:
    # Only text columns can be large; count them as stored bytes.
    return " + ".join(f"coalesce(length(CAST({column} AS BLOB)), 0)" for column in spec.columns)


def _pages(spec: TableSpec, query: Query) -> list[tuple[tuple[Any, ...], tuple[Any, ...]]]:
    """Inclusive key ranges, each at most PAGE_ROWS rows or PAGE_BYTES bytes (or one larger row)."""
    order = ", ".join(spec.key)
    ranges: list[tuple[tuple[Any, ...], tuple[Any, ...]]] = []
    first: tuple[Any, ...] | None = None
    last: tuple[Any, ...] | None = None
    rows = size = 0
    cursor: tuple[Any, ...] | None = None
    while True:
        listing = query(
            f"SELECT {order}, {_row_bytes(spec)} AS row_bytes FROM {spec.name}"
            f" WHERE {spec.owned}{_after(spec, cursor)} ORDER BY {order} LIMIT {PAGE_ROWS}"
        )
        for item in listing:
            key = tuple(item[name] for name in spec.key)
            if first is not None and (rows >= PAGE_ROWS or size + item["row_bytes"] > PAGE_BYTES):
                ranges.append((first, last))  # type: ignore[arg-type]
                first, rows, size = None, 0, 0
            if first is None:
                first = key
            last, rows, size = key, rows + 1, size + item["row_bytes"]
            cursor = key
        if len(listing) < PAGE_ROWS:
            break
    if first is not None:
        ranges.append((first, last))  # type: ignore[arg-type]
    return ranges


def _range_condition(spec: TableSpec, low: tuple[Any, ...], high: tuple[Any, ...]) -> str:
    names = ", ".join(spec.key)
    if len(spec.key) == 1:
        return f"{names} BETWEEN {sql_literal(low[0])} AND {sql_literal(high[0])}"
    low_values = ", ".join(sql_literal(value) for value in low)
    high_values = ", ".join(sql_literal(value) for value in high)
    return f"({names}) >= ({low_values}) AND ({names}) <= ({high_values})"


def read_table(spec: TableSpec, query: Query) -> list[tuple[Any, ...]]:
    columns = ", ".join(spec.columns)
    rows: list[tuple[Any, ...]] = []
    for low, high in _pages(spec, query):
        page = query(
            f"SELECT {columns} FROM {spec.name} WHERE {spec.owned}"
            f" AND {_range_condition(spec, low, high)} ORDER BY {', '.join(spec.key)}"
        )
        rows.extend(tuple(item[name] for name in spec.columns) for item in page)
    return rows


def verify(manifest: dict[str, Any], query: Query) -> list[str]:
    """One PASS/FAIL line per table in the manifest, plus the ledger state counts."""
    if manifest.get("format") != FORMAT:
        raise VerifyError(f"manifest format is not {FORMAT}")
    lines = []
    for spec in TABLES:
        expected = manifest["tables"].get(spec.name)
        if expected is None:
            continue
        rows = read_table(spec, query)
        count, digest = table_digest(spec, rows)
        same_digest = digest == expected["sha256"]
        ok = count == expected["rows"] and same_digest
        detail = f"rows={count}" if ok else f"rows={count} expected={expected['rows']} sha256_match={same_digest}"
        lines.append(f"{'PASS' if ok else 'FAIL'} {spec.name} {detail}")
        if spec is LEDGER:
            states = dict(sorted(Counter(row[spec.columns.index("state")] for row in rows).items()))
            ok = states == manifest["state_counts"]
            lines.append(f"{'PASS' if ok else 'FAIL'} mail_events state_counts {json.dumps(states)}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--manifest", type=Path, required=True)
    where = parser.add_mutually_exclusive_group(required=True)
    where.add_argument("--local", action="store_true", help="the local D1 of wrangler dev")
    where.add_argument("--remote", action="store_true", help="the production D1 (needs wrangler login)")
    parser.add_argument("--db", default="todofy", help="D1 database name or binding (default: todofy)")
    parser.add_argument("--persist-to", help="wrangler --persist-to directory (with --local)")
    parser.add_argument("--config", help="wrangler config file")
    parser.add_argument(
        "--wrangler",
        default="npx --no-install wrangler",
        help="command that runs wrangler (default: %(default)s)",
    )
    args = parser.parse_args(argv)
    if args.persist_to and not args.local:
        parser.error("--persist-to needs --local")
    target = ["--local" if args.local else "--remote"]
    if args.persist_to:
        target += ["--persist-to", args.persist_to]
    if args.config:
        target += ["--config", args.config]
    query = wrangler_query(shlex.split(args.wrangler), args.db, target)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        lines = verify(manifest, query)
    except (OSError, ValueError, KeyError, VerifyError) as error:
        print(f"verify FAIL: {error}", file=sys.stderr)
        return 2
    for line in lines:
        print(line)
    passed = all(line.startswith("PASS") for line in lines)
    print("verify PASS" if passed else "verify FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
