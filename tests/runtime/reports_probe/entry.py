"""Test-only Worker that drives reports, reminder and retention directly (never shipped).

`tests/runtime/reports_probe/__init__.py` stages it next to a copy of
`worker/todofy`, so these modules run in real workerd with real D1 but without
the coordinator's alarm loop. POST routes take JSON arguments (``vars``
overrides Worker vars for that call, ``now`` is the Unix time the module sees);
the newsletter routes are the real ``reports.serve`` and read overrides from
the ``x-probe-vars`` header. ``ProbeCoordinator`` answers ``/report`` with the
real ``reports.compute`` and an unlimited budget.
"""

import json
from dataclasses import replace
from typing import Any
from urllib.parse import urlsplit

from workers import DurableObject, Response, WorkerEntrypoint

from todofy.core.vocab import EventState
from todofy.runtime import ledger, reminder, reports, retention
from todofy.runtime.http import error, json_response
from todofy.runtime.interop import now_ms


class Overlay:
    """The Worker env with some vars replaced, so one probe serves every scenario."""

    def __init__(self, env: Any, overrides: dict[str, str]) -> None:
        self._env = env
        self._overrides = overrides

    def __getattr__(self, name: str) -> Any:
        return self._overrides[name] if name in self._overrides else getattr(self._env, name)


class Budget:
    """Stands in for the coordinator's hourly report cap, Gemini token budget and
    precompute failure counts (``failures`` maps "kind/top_n/day" to a count)."""

    def __init__(self, slots: bool = True, tokens: bool = True, failures: dict[str, int] | None = None) -> None:
        self.slots = slots
        self.tokens = tokens
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
        return self.tokens

    def settle_tokens(self, reserved: int, used: int, now: int) -> None:
        self.calls.append(["settle", reserved, used, now])


class ProbeCoordinator(DurableObject):
    async def fetch(self, request: Any) -> Response:
        args = json.loads(await request.text())
        try:
            report = await reports.compute(
                self.env, Budget(), args["kind"], args["top_n"], now_ms() // 1000, args["budget_ms"]
            )
        except reports.ReportError as exc:
            return error(exc.status, exc.code)
        return json_response(report)


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        path = urlsplit(request.url).path
        if path == "/health":
            return Response("ok")
        if request.method == "GET" and path in ("/api/summary", "/api/recommendation"):
            env = Overlay(self.env, json.loads(request.headers.get("x-probe-vars") or "{}"))
            return await reports.serve(request, env, path.removeprefix("/api/"))
        args = json.loads(await request.text())
        env = Overlay(self.env, args.get("vars", {}))
        budget = Budget(args.get("slots", True), args.get("tokens", True), args.get("failures"))
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
            case _:
                return Response("not found", status=404)
        data["budget"] = budget.calls
        return Response(json.dumps(data, ensure_ascii=False), headers={"content-type": "application/json"})
