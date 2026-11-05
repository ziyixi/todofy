"""Host stand-ins for the runtime modules' platform: D1 and the object's SQLite as host SQLite, and the Pyodide
modules runtime/ imports (test_mail.py, test_backup_job.py). Synthetic data only.
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


class Row(dict[str, Any]):
    """A D1 result row that supports both dict indexing and attribute access (like Pyodide's JsProxy)."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


class Statement:
    def __init__(self, db: "D1", sql: str, args: tuple[Any, ...] = ()) -> None:
        self.db, self.sql, self.args = db, sql, args

    def bind(self, *args: Any) -> "Statement":
        return Statement(self.db, self.sql, args)

    def rows(self) -> list[Row]:
        return self.result().results

    def result(self) -> Any:
        """D1's result: the rows and ``meta.changes``, the rows the statement wrote."""
        if self.db.failing and (self.db.fail_sql is None or self.db.fail_sql in self.sql):
            raise self.db.failing("synthetic D1 failure")
        self.db.statements.append(self.sql)
        before = self.db.db.total_changes
        rows = [Row(row) for row in self.db.db.execute(self.sql, self.args).fetchall()]
        self.db.db.commit()
        return types.SimpleNamespace(
            results=rows, meta=types.SimpleNamespace(changes=self.db.db.total_changes - before)
        )

    async def run(self) -> Any:
        return self.result()

    async def first(self) -> Row | None:
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
        self.fail_sql: str | None = None

    def prepare(self, sql: str) -> Statement:
        return Statement(self, sql)

    async def batch(self, statements: list[Statement]) -> list[Any]:
        return [statement.result() for statement in statements]

    def sql(self, query: str, *params: Any) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.db.execute(query, params).fetchall()]
        self.db.commit()
        return rows

    def insert(self, table: str, **row: Any) -> None:
        self.sql(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", *row.values())


class Cursor:
    def __init__(self, rows: list[sqlite3.Row], rows_written: int) -> None:
        self.rows = rows
        self.rowsWritten = rows_written  # the JS name; host SQLite counts the rows changed, not index entries

    def toArray(self) -> list[types.SimpleNamespace]:  # the JS name
        return [types.SimpleNamespace(**dict(row)) for row in self.rows]

    def one(self) -> types.SimpleNamespace:
        [row] = self.toArray()
        return row


class ObjectSql:
    """ctx.storage.sql: synchronous exec on host SQLite."""

    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.db.row_factory = sqlite3.Row

    def exec(self, sql: str, *args: Any) -> Cursor:
        before = self.db.total_changes
        rows = self.db.execute(sql, args).fetchall()
        return Cursor(rows, self.db.total_changes - before)


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
    for name in ("DurableObject", "Response", "WorkerEntrypoint", "Request"):
        setattr(stubs["workers"], name, object)
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    try:
        yield {"clock": clock, "JsException": stubs["pyodide.ffi"].JsException}
    finally:
        for name in set(sys.modules) - before:
            if name.startswith("todofy.runtime"):
                del sys.modules[name]


# 2026-09-28T15:00:00Z, after the 13:30 precompute time.
NOW = 1_790_607_600


def text_reply(text: str, *, tokens: int = 100, model: str = "gemini-probe") -> dict[str, Any]:
    return {
        "output": text,
        "model": model,
        "usage": types.SimpleNamespace(
            available=True,
            input_tokens=tokens // 2,
            output_tokens=tokens - tokens // 2,
        ),
        "error": None,
    }


def error_reply(status: int) -> dict[str, Any]:
    reason = "MODEL_QUOTA" if status == 429 else "MODEL_AUTH" if status in {400, 401, 403} else "MODEL_UNAVAILABLE"
    return {
        "output": "",
        "model": "",
        "usage": types.SimpleNamespace(available=False, input_tokens=0, output_tokens=0),
        "error": types.SimpleNamespace(reason=reason, retry_after_seconds=0.0),
    }


class HostGemini:
    """In-memory stand-in for model.client(env, deadline_ms) in unit tests."""

    def __init__(self) -> None:
        self._queue: list[dict[str, Any]] = []
        self._calls: list[types.SimpleNamespace] = []

    def queue_generate(self, reply: dict[str, Any]) -> None:
        self._queue.append(reply)

    def calls(self) -> list[types.SimpleNamespace]:
        return list(self._calls)

    def reset(self) -> None:
        self._queue.clear()
        self._calls.clear()

    async def generate(self, request: Any) -> Any:
        import json
        import math

        schema = json.loads(request.output_schema_json) if request.output_schema_json else None
        system = "\n\n".join(item.text for item in request.instructions)
        user = request.input
        self._calls.append(
            types.SimpleNamespace(
                model=request.model,
                requested_model=request.model,
                system=system,
                user=user,
                response_schema=schema,
            )
        )
        if self._queue:
            reply = self._queue.pop(0)
        else:
            tokens = math.ceil(len(system + user) / 4) + 20
            if schema is not None:
                count = min(int(schema.get("maxItems", 3)), 3)
                items = [
                    {"rank": rank, "title": f"合成任务 {rank}", "reason": f"合成理由 {rank}"}
                    for rank in range(1, count + 1)
                ]
                reply = text_reply(json.dumps(items, ensure_ascii=False), tokens=tokens)
            else:
                reply = text_reply(f"合成摘要（{request.model}）：{len(user)} 字符。", tokens=tokens)
        return types.SimpleNamespace(
            output=reply["output"],
            model=reply.get("model") or request.model,
            usage=reply["usage"],
            error=reply["error"],
        )


class _Budget:
    def __init__(
        self,
        env: Any,
        slots: bool = True,
        tokens: bool = True,
        failures: dict[str, int] | None = None,
        token_limit: int | None = None,
    ) -> None:
        self.env = env
        self.slots = slots
        self.tokens = tokens
        self.token_limit = token_limit
        self.failures = dict(failures or {})
        self.calls: list[list[Any]] = []

    def report_failures(self, kind: str, top_n: int, day: str) -> int:
        return self.failures.get(f"{kind}/{top_n}/{day}", 0)

    def count_report_failure(self, kind: str, top_n: int, day: str) -> None:
        self.calls.append(["failure", kind, top_n, day])

    def take_report_slot(self, now: int) -> bool:
        self.calls.append(["slot", now])
        return self.slots

    def reserve_tokens(self, tokens: int, now: int) -> bool:
        self.calls.append(["reserve", tokens, now])
        return self.tokens and (self.token_limit is None or tokens <= self.token_limit)

    def settle_tokens(self, reserved: int, used: int, now: int) -> None:
        self.calls.append(["settle", reserved, used, now])

    def record_step(self, point: Any, now: int) -> None:
        pass

    async def compute_report(self, kind: str, top_n: int, now: int) -> tuple[int, Any]:
        from todofy.core.backoff import REPORT_ON_DEMAND_BUDGET
        from todofy.runtime import reports

        try:
            return 200, await reports.compute(self.env, self, kind, top_n, now, REPORT_ON_DEMAND_BUDGET * 1000)
        except reports.ReportError as exc:
            return exc.status, exc.code


class HostProbe:
    """In-memory host equivalent of tests/runtime/reports_probe/entry.py on host SQLite."""

    def __init__(self, clock: dict[str, int]) -> None:
        self.db = D1()
        self.gemini = HostGemini()
        self.clock = clock

    def sql(self, query: str, *params: Any) -> list[dict[str, Any]]:
        return self.db.sql(query, *params)

    def insert(self, table: str, **row: Any) -> None:
        self.db.insert(table, **row)

    def call(self, path: str, **args: Any) -> dict[str, Any]:
        import asyncio
        from dataclasses import replace

        from todofy.core.vocab import EventState

        overrides: dict[str, Any] = dict(args.get("vars", {}))
        self.db.failing = RuntimeError if args.get("fail_sql") else None
        self.db.fail_sql = args.get("fail_sql")
        env = types.SimpleNamespace(DB=self.db, TODOFY_PUBLIC_HOST="todofy.example", **overrides)
        budget = _Budget(
            env, args.get("slots", True), args.get("tokens", True), args.get("failures"), args.get("token_limit")
        )
        data: dict[str, Any] = {}
        try:
            match path:
                case "/d1":
                    results = asyncio.run(
                        self.db.batch([self.db.prepare(sql).bind(*params) for sql, params in args["statements"]])
                    )
                    data["results"] = [[dict(row) for row in result.results] for result in results]
                case "/reports/compute":
                    from todofy.runtime import reports

                    try:
                        data["report"] = asyncio.run(
                            reports.compute(env, budget, args["kind"], args["top_n"], args["now"], args["budget_ms"])
                        )
                    except reports.ReportError as exc:
                        data["error"] = [exc.status, exc.code]
                case "/reports/tick":
                    from todofy.runtime import reports

                    data["next"] = asyncio.run(reports.tick(env, budget, args["now"]))
                case "/reports/latest":
                    from todofy.runtime import reports

                    data["latest"] = asyncio.run(reports.latest(self.db))
                case "/ledger/transition":
                    from todofy.runtime import ledger

                    row = asyncio.run(ledger.get(self.db, args["source_id"], args["event_id"]))
                    assert row is not None
                    snapshot = replace(row, state=EventState(args["from_state"]), version=args["version"])
                    action = ledger.OwnerAction(**args["action"]) if args.get("action") else None
                    moved = asyncio.run(
                        ledger.transition(
                            self.db,
                            snapshot,
                            EventState(args["to"]),
                            actor=args["actor"],
                            now=args["now"],
                            code=args.get("code", ""),
                            action=action,
                        )
                    )
                    data["moved"] = moved is not None
                case "/retention/tick":
                    from todofy.runtime import retention

                    data["more"] = asyncio.run(retention.tick(self.db, env, args["now"]))
                case _:
                    raise ValueError(f"unknown probe path: {path}")
        finally:
            self.db.failing = None
            self.db.fail_sql = None
        data["budget"] = budget.calls
        return data


@contextmanager
def host_probe(monkeypatch: pytest.MonkeyPatch) -> Iterator[HostProbe]:
    with stubbed_pyodide(monkeypatch) as stubs:
        probe = HostProbe(stubs["clock"])
        try:
            from todofy.runtime import model
        except ImportError:
            pass
        else:
            monkeypatch.setattr(model, "client", lambda *_args: probe.gemini)
        yield probe
