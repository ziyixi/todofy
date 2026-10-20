"""Host stand-ins for the runtime modules' platform: D1 and the object's SQLite as host SQLite, the object's
storage, the Pyodide modules runtime/ imports, and the Tasks service binding (test_plus_*.py,
test_backup_job.py). Synthetic data only.
"""

import json
import sqlite3
import sys
import types
from collections.abc import Collection, Iterator
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


def _status(code: int, reason: str) -> types.SimpleNamespace:
    details = [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}]
    return types.SimpleNamespace(status=code, body=json.dumps({"error": {"code": code, "details": details}}))


class NativeTasks:
    """The TASKS binding of a host test: the Tasks rules the Mail handlers rely on, over plain dicts.

    Every write takes the task's current etag; a request ID runs once (the same request answers as before, another
    is ALREADY_EXISTS); a recurring task completes by counting up and staying open. ``calls`` journals each call,
    ``failures`` lists the statuses a method's next calls answer with (None: answered as usual), and a method in
    ``lose`` is applied but its answer lost. ``journal`` (shared with Storage, say) gets each method's name too."""

    def __init__(self, time_zone: str = "UTC", labels: Collection[str] = (), journal: list[str] | None = None) -> None:
        self.time_zone = time_zone
        self.journal = journal if journal is not None else []
        self.labels = [{"id": "id-" + title, "name": "labels/id-" + title, "title": title} for title in labels]
        self.tasks: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.failures: dict[str, list[int | None]] = {}
        self.lose: set[str] = set()
        self._requests: dict[str, tuple[str, dict[str, Any]]] = {}

    def add(self, task_id: str, *, recurring: bool = False, **fields: Any) -> dict[str, Any]:
        row = {"id": task_id, "name": f"tasks/{task_id}", "title": "Synthetic " + task_id, "etag": "1", **fields}
        if recurring:
            row |= {"due_date": "2026-10-20", "recurrence": "every week"}
        self.tasks[task_id] = row
        return row

    def methods(self) -> list[str]:
        return [method for method, _ in self.calls]

    async def call(self, method: str, text: str) -> types.SimpleNamespace:
        body = json.loads(text)
        self.calls.append((method, body))
        self.journal.append(method)
        if self.failures.get(method) and (status := self.failures[method].pop(0)) is not None:
            return _status(status, "UNAVAILABLE")
        if method == "GetCatalog":
            inbox = {"id": "inbox", "name": "projects/inbox", "title": "Inbox", "inbox": True}
            return self._ok(
                {"name": "catalog", "time_zone": self.time_zone, "labels": self.labels, "projects": [inbox]}
            )
        if method == "GetTask":
            row = self.tasks.get(body["name"].removeprefix("tasks/"))
            return self._ok(row) if row is not None else _status(404, "NOT_FOUND")
        if method == "ListTasks":
            return self._ok(self._page(body))
        key = body.get("request_id", "")
        if key in self._requests:
            sent, answer = self._requests[key]
            return self._ok(answer) if sent == text else _status(409, "ALREADY_EXISTS")
        answer = self._write(method, body)
        if isinstance(answer, types.SimpleNamespace):
            return answer
        self._requests[key] = (text, answer)
        if method in self.lose:
            raise OSError("synthetic answer lost")
        return self._ok(answer)

    @staticmethod
    def _ok(value: dict[str, Any]) -> types.SimpleNamespace:
        return types.SimpleNamespace(status=200, body=json.dumps(value))

    def _page(self, body: dict[str, Any]) -> dict[str, Any]:
        rows = [row for row in self.tasks.values() if not row.get("completed") and not row.get("archived")]
        if ids := body.get("task_ids"):
            rows = [row for row in rows if row["id"] in ids]
        if project := body.get("project_id"):
            rows = [row for row in rows if row.get("project_id", "") == project]
        start, size = int(body.get("page_token") or 0), min(body.get("page_size") or 100, 100)
        following = str(start + size) if start + size < len(rows) else ""
        return {"tasks": rows[start : start + size], **({"next_page_token": following} if following else {})}

    def _bump(self, row: dict[str, Any]) -> dict[str, Any]:
        row["etag"] = str(int(row["etag"]) + 1)
        return row

    def _write(self, method: str, body: dict[str, Any]) -> dict[str, Any] | types.SimpleNamespace:
        if method == "CreateTask":
            fields = body["task"]
            parent = self.tasks.get(fields.get("parent_id", ""))
            task_id = body.get("task_id") or f"created-{len(self.tasks) + 1}"
            project = {"project_id": parent.get("project_id", "")} if parent else {}
            return dict(self.add(task_id, **(project | fields)))
        if method == "ReorderTasks":
            rows = [self.tasks.get(position["name"].removeprefix("tasks/")) for position in body["positions"]]
            if any(
                row is None or row["etag"] != position["etag"]
                for row, position in zip(rows, body["positions"], strict=True)
            ):
                return _status(409, "ETAG_MISMATCH")
            for row, position in zip(rows, body["positions"], strict=True):
                self._bump(row)["sort_order"] = position["sort_order"]
            return {}
        name = body.get("name") or body["task"]["name"]
        row = self.tasks.get(name.removeprefix("tasks/"))
        if row is None:
            return _status(404, "NOT_FOUND")
        if row["etag"] != body.get("etag", row["etag"]):
            return _status(409, "ETAG_MISMATCH")
        if method == "DeleteTask":
            del self.tasks[row["id"]]
            return {}
        if method == "UpdateTask":
            for field in body["update_mask"].split(","):
                row[field] = body["task"].get(field, "")
        elif method == "CompleteTask":
            if row.get("recurrence"):
                row["completed_count"] = row.get("completed_count", 0) + 1
            else:
                row |= {"completed": True, "complete_time": "2026-10-14T16:00:00Z"}
        return dict(self._bump(row))
