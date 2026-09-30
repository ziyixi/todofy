"""Test-only Worker that drives reports, reminder, retention and the GTD ledger directly (never shipped).

`tests/runtime/reports_probe/__init__.py` stages it next to a copy of
`worker/todofy`, so these modules run in real workerd with real D1 but without
the coordinator's alarm loop. POST routes take JSON arguments (``vars``
overrides Worker vars for that call, ``now`` is the Unix time the module sees);
the newsletter routes are the real ``reports.serve`` (what the object runs after
the gateway accepted the Basic credential) with an unlimited ``Budget`` as the
coordinator, answered the way the gateway turns a ``Result`` into HTTP, and read
overrides from the ``x-probe-vars`` header.
"""

import json
from dataclasses import asdict, replace
from typing import Any
from urllib.parse import urlsplit

from workers import DurableObject, Response, WorkerEntrypoint

from todofy.core import gtd as gtd_rules
from todofy.core import ops
from todofy.core.backoff import REPORT_ON_DEMAND_BUDGET, TODOIST_AUTH_BLOCK
from todofy.core.vocab import EventState
from todofy.runtime import gtd, ledger, reminder, reports, retention
from todofy.runtime import ops as ops_runtime
from todofy.runtime.http import Result

JSON = "application/json; charset=utf-8"


class Overlay:
    """The Worker env with some vars (or the DB binding) replaced, so one probe serves every scenario."""

    def __init__(self, env: Any, overrides: dict[str, Any]) -> None:
        self._env = env
        self._overrides = overrides

    def __getattr__(self, name: str) -> Any:
        return self._overrides[name] if name in self._overrides else getattr(self._env, name)


class FailingDb:
    """D1 whose ``prepare`` raises for any statement containing ``marker`` (a failed read), for the
    fallbacks that must survive one; every other statement goes to the real database."""

    def __init__(self, db: Any, marker: str) -> None:
        self._db = db
        self._marker = marker

    def prepare(self, sql: str) -> Any:
        if self._marker in sql:
            raise RuntimeError("injected D1 failure")
        return self._db.prepare(sql)

    def batch(self, statements: Any) -> Any:
        return self._db.batch(statements)


class Budget:
    """Stands in for the coordinator: its hourly report cap, Gemini token budget,
    precompute failure counts (``failures`` maps "kind/top_n/day" to a count),
    the largest token reservation it grants (``token_limit``; None: any),
    on-demand report computation and the stored ops report (``ops_report``, an
    OpsReport the object would hold)."""

    def __init__(
        self,
        env: Any,
        slots: bool = True,
        tokens: bool = True,
        failures: dict[str, int] | None = None,
        ops_report: dict[str, Any] | None = None,
        token_limit: int | None = None,
    ) -> None:
        self.env = env
        self.slots = slots
        self.tokens = tokens
        self.token_limit = token_limit
        self.failures = dict(failures or {})
        self.ops_report = None if ops_report is None else ops.stored_report(ops.compact(ops_report))
        self.calls: list[list[Any]] = []

    def latest_ops_report(self) -> ops.Report | None:
        return self.ops_report

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
        """Metrics are the coordinator's business; the probe only drives the modules."""

    async def compute_report(self, kind: str, top_n: int, now: int) -> tuple[int, Any]:
        """The coordinator's on-demand computation, as reports.serve calls it."""
        try:
            return 200, await reports.compute(self.env, self, kind, top_n, now, REPORT_ON_DEMAND_BUDGET * 1000)
        except reports.ReportError as exc:
            return exc.status, exc.code


class GtdHost:
    """Stands in for the coordinator in runtime/gtd.py: the object's storage, the Todoist budget
    (``wait`` is what ``todoist_wait`` answers: None means Todoist may be called), the auth block,
    step metrics and the stored ops report. ``calls`` records what the module asked for."""

    def __init__(self, env: Any, store: Any, wait: int | None, ops_report: dict[str, Any] | None) -> None:
        self.env = env
        self.sql = store
        self.wait = wait
        self.ops_report = None if ops_report is None else ops.stored_report(ops.compact(ops_report))
        self.calls: list[list[Any]] = []

    def count_todoist_calls(self, calls: int, now: int) -> None:
        self.calls.append(["count", calls, now])

    def todoist_wait(self, now: int) -> int | None:
        return self.wait

    def block_todoist(self, now: int) -> int:
        self.calls.append(["block", now])
        return now + TODOIST_AUTH_BLOCK

    def record_step(self, point: Any, now: int) -> None:
        self.calls.append(["step", str(point.step), str(point.outcome), point.code])

    def latest_ops_report(self) -> ops.Report | None:
        return self.ops_report


class GtdProbe(DurableObject):
    """A real object storage for runtime/gtd.py; ``run`` takes one JSON request and answers JSON."""

    def __init__(self, ctx: Any, env: Any) -> None:
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        for statement in (*gtd.DO_SCHEMA, *ops_runtime.DO_SCHEMA):
            self.sql.exec(statement)

    async def run(self, text: str) -> str:
        args = json.loads(text)
        env = Overlay(self.env, args.get("vars", {}))
        host = GtdHost(env, self.sql, args.get("wait"), args.get("ops_report"))
        data: dict[str, Any] = {}
        match args["op"]:
            case "tick":
                if patch := args.get("state"):
                    state = gtd.load(self.sql)
                    for name, value in patch.items():
                        setattr(state, name, value)
                    gtd.save(self.sql, state)
                await gtd.tick(env, host, args["now"])
            case "reset":
                for table in ("gtd_state", "ops_guard", "ops_job_runs"):
                    self.sql.exec(f"DELETE FROM {table}")
            case "guard":
                wanted = ops.guard_input(args["guard"], args["now"] * 1000)
                ops_runtime.set_guard(self.sql, wanted, args["now"] * 1000)
                if args.get("ran") is not None:
                    ops_runtime.ran(self.sql, ops.Job.GTD_SNAPSHOT, args["ran"])
            case "release":
                gtd.release(self.sql, args["now"])
            case "retry_later":
                gtd.retry_later(self.sql, args["now"], args["at"])
        facts = gtd.facts(env, self.sql)
        now = args.get("now", 0)
        data["state"] = asdict(gtd.load(self.sql))
        data["facts"] = asdict(facts) | {
            "snapshot_age": gtd_rules.snapshot_age(facts, now),
            "review_age_days": gtd_rules.review_age_days(facts, now),
        }
        data["next_at"] = gtd.next_at(self.sql)
        data["calls"] = host.calls
        return json.dumps(data, ensure_ascii=False)


def _http(result: Result) -> Response:
    """The gateway's response for a core result (gateway/src/coordinator.ts), with a fixed request ID."""
    wire = result.wire()
    headers = {"content-type": JSON}
    if wire["retry_after"] is not None:
        headers["retry-after"] = str(wire["retry_after"])
    if wire["error"] is None:
        return Response(wire["body"], status=wire["status"], headers=headers)
    envelope = {"error": wire["error"] | {"request_id": "0" * 16}}
    return Response(json.dumps(envelope, ensure_ascii=False), status=wire["status"], headers=headers)


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        path = urlsplit(request.url).path
        if path == "/health":
            return Response("ok")
        if request.method == "GET" and path in ("/api/summary", "/api/recommendation"):
            env = Overlay(self.env, json.loads(request.headers.get("x-probe-vars") or "{}"))
            return _http(await reports.serve(env, Budget(env), path.removeprefix("/api/"), urlsplit(request.url).query))
        args = json.loads(await request.text())
        overrides: dict[str, Any] = dict(args.get("vars", {}))
        if marker := args.get("fail_sql"):
            overrides["DB"] = FailingDb(self.env.DB, marker)
        env = Overlay(self.env, overrides)
        budget = Budget(
            env,
            args.get("slots", True),
            args.get("tokens", True),
            args.get("failures"),
            args.get("ops_report"),
            args.get("token_limit"),
        )
        data: dict[str, Any] = {}
        match path:
            case "/d1":
                results = await self.env.DB.batch(
                    [self.env.DB.prepare(sql).bind(*params) for sql, params in args["statements"]]
                )
                data["results"] = [[dict(row) for row in result.results] for result in results]
            case "/reports/compute":
                try:
                    data["report"] = await reports.compute(
                        env, budget, args["kind"], args["top_n"], args["now"], args["budget_ms"]
                    )
                except reports.ReportError as exc:
                    data["error"] = [exc.status, exc.code]
            case "/reports/tick":
                data["next"] = await reports.tick(env, budget, args["now"])
            case "/reports/latest":
                data["latest"] = await reports.latest(self.env.DB)
            case "/reminder/tick":
                data["next"] = await reminder.tick(env, budget, args["now"])
            case "/reminder/page":
                items, next_day = await reminder.page(self.env.DB, args.get("before_day"), args["limit"])
                data |= {"items": items, "next_day": next_day}
            case "/ledger/transition":
                # ledger.transition from a row snapshot whose state and version the test chooses.
                row = await ledger.get(self.env.DB, args["source_id"], args["event_id"])
                snapshot = replace(row, state=EventState(args["from_state"]), version=args["version"])
                action = ledger.OwnerAction(**args["action"]) if args.get("action") else None
                moved = await ledger.transition(
                    self.env.DB,
                    snapshot,
                    EventState(args["to"]),
                    actor=args["actor"],
                    now=args["now"],
                    code=args.get("code", ""),
                    action=action,
                )
                data["moved"] = moved is not None
            case "/retention/tick":
                data["more"] = await retention.tick(self.env.DB, env, args["now"])
            case "/gtd":
                # runtime/gtd.py in the probe's object (GtdProbe): op tick, reset, guard, release.
                stub = self.env.GTD_PROBE.getByName("probe")
                data |= json.loads(await stub.run(json.dumps(args)))
            case "/gtd/daily":
                data["daily"] = await gtd.daily(self.env.DB, args["days"], args["now"])
            case _:
                return Response("not found", status=404)
        data["budget"] = budget.calls
        return Response(json.dumps(data, ensure_ascii=False), headers={"content-type": "application/json"})
