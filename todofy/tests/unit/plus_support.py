"""Host stand-ins for the runtime modules' platform: D1 and the object's SQLite as host SQLite, the object's
storage, and the Pyodide modules runtime/ imports (test_plus_rollover.py, test_plus_cache.py,
test_plus_receipts.py, test_backup_job.py). Synthetic data only.
"""

import sqlite3
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


class Statement:
    def __init__(self, db: "D1", sql: str, args: tuple[Any, ...] = ()) -> None:
        self.db, self.sql, self.args = db, sql, args

    def bind(self, *args: Any) -> "Statement":
        return Statement(self.db, self.sql, args)

    def rows(self) -> list[dict[str, Any]]:
        if self.db.failing:
            raise self.db.failing("synthetic D1 failure")
        self.db.statements.append(self.sql)
        rows = [dict(row) for row in self.db.db.execute(self.sql, self.args).fetchall()]
        self.db.db.commit()
        return rows

    async def run(self) -> None:
        self.rows()

    async def first(self) -> dict[str, Any] | None:
        rows = self.rows()
        return rows[0] if rows else None

    async def all(self) -> Any:
        return types.SimpleNamespace(results=self.rows())


class D1:
    """Every migration on host SQLite; ``failing`` (an exception class) makes each statement raise it."""

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        for path in sorted(MIGRATIONS.glob("*.sql")):
            self.db.executescript(path.read_text())
        self.statements: list[str] = []
        self.failing: type[Exception] | None = None

    def prepare(self, sql: str) -> Statement:
        return Statement(self, sql)

    async def batch(self, statements: list[Statement]) -> list[Any]:
        return [types.SimpleNamespace(results=statement.rows()) for statement in statements]

    def weeks(self) -> dict[str, tuple[str, int, int]]:
        rows = self.db.execute("SELECT task_id, week_start, committed, bet FROM plus_weeks").fetchall()
        return {row[0]: (row[1], row[2], row[3]) for row in rows}


class Cursor:
    def __init__(self, rows: list[sqlite3.Row], rows_written: int) -> None:
        self.rows = rows
        self.rowsWritten = rows_written  # the JS name; host SQLite counts the rows changed, not index entries

    def toArray(self) -> list[types.SimpleNamespace]:  # the JS name
        return [types.SimpleNamespace(**dict(row)) for row in self.rows]


class ObjectSql:
    """ctx.storage.sql: synchronous exec on host SQLite."""

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.db.row_factory = sqlite3.Row

    def exec(self, sql: str, *args: Any) -> Cursor:
        before = self.db.total_changes
        rows = self.db.execute(sql, args).fetchall()
        return Cursor(rows, self.db.total_changes - before)


class Storage:
    """ctx.storage: its SQLite and sync(), which records where in a run it was awaited."""

    def __init__(self, journal: list[str]) -> None:
        self.sql = ObjectSql()
        self.journal = journal

    async def sync(self) -> None:
        self.journal.append("storage.sync")


@contextmanager
def stubbed_pyodide(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    """Stubs of js, pyodide.ffi and workers with a settable clock (``clock["ms"]``) and the JsException class;
    every todofy.runtime module imported meanwhile is removed afterwards."""
    before = set(sys.modules)
    clock = {"ms": 0}
    stubs = {name: types.ModuleType(name) for name in ("js", "pyodide", "pyodide.ffi", "workers")}
    stubs["js"].Date = types.SimpleNamespace(now=lambda: clock["ms"])
    stubs["js"].Object = types.SimpleNamespace(fromEntries=lambda entries: dict(entries))
    stubs["pyodide.ffi"].to_js = lambda value, dict_converter=None: value
    stubs["pyodide.ffi"].JsException = type("JsException", (Exception,), {})
    stubs["workers"].fetch = None
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    try:
        yield {"clock": clock, "JsException": stubs["pyodide.ffi"].JsException}
    finally:
        for name in set(sys.modules) - before:
            if name.startswith("todofy.runtime"):
                del sys.modules[name]
