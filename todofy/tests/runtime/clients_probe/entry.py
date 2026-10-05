"""Test-only Worker that calls the upstream clients and the body reader directly (never shipped).

`tests/runtime/clients_probe/__init__.py` stages it next to a copy of
`worker/todofy`, so the clients run in real workerd without the ledger around
them. Each route takes JSON arguments (``vars`` overrides Worker vars for that
call) and answers the client's result as JSON.
"""

import json
from typing import Any
from urllib.parse import urlsplit

import js
from pyodide.ffi import create_proxy
from workers import Response, WorkerEntrypoint

from todofy.core.todoist_request import build_task_request
from todofy.runtime import gemini, todoist
from todofy.runtime.config import var
from todofy.runtime.interop import now_ms, read_capped, to_js


class Overlay:
    """The Worker env with some vars replaced, so one probe serves every scenario."""

    def __init__(self, env: Any, overrides: dict[str, str]) -> None:
        self._env = env
        self._overrides = overrides

    def __getattr__(self, name: str) -> Any:
        return self._overrides[name] if name in self._overrides else getattr(self._env, name)


async def read_from_stub(chunk: int, chunks: int, limit: int) -> dict[str, Any]:
    """``read_capped`` on a JS stream of ``chunks`` pieces of ``chunk`` bytes: what it returned,
    how many pieces it asked for (no queueing ahead: one per read) and whether it cancelled."""
    served = {"pulled": 0, "cancelled": False}

    def pull(controller: Any) -> None:
        if served["pulled"] == chunks:
            controller.close()
            return
        served["pulled"] += 1
        controller.enqueue(to_js(b"x" * chunk))

    def cancel(_reason: Any) -> None:
        served["cancelled"] = True

    proxies = [create_proxy(pull), create_proxy(cancel)]
    try:
        source = to_js({"pull": proxies[0], "cancel": proxies[1]})
        stream = js.ReadableStream.new(source, to_js({"highWaterMark": 0}))
        body = await read_capped(stream, limit)
    finally:
        for proxy in proxies:
            proxy.destroy()
    return {"size": None if body is None else len(body)} | served


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        path = urlsplit(request.url).path
        if path == "/health":
            return Response("ok")
        args = json.loads(await request.text())
        env = Overlay(self.env, args.get("vars", {}))
        started = now_ms()
        match path:
            case "/gemini":
                result = await gemini.generate(
                    env,
                    system=args["system"],
                    user=args["user"],
                    deadline_ms=started + args["budget_ms"],
                    response_schema=args.get("response_schema"),
                    preface=args.get("preface", ""),
                    models=args.get("models"),
                )
                data = {
                    "ok": result.verdict.ok,
                    "code": result.verdict.code,
                    "next_model": result.verdict.next_model,
                    "retry_after": result.verdict.retry_after,
                    "text": result.text,
                    "model": result.model,
                    "tokens": result.tokens,
                    "prompt_tokens": result.prompt_tokens,
                    "attempts": result.attempts,
                }
            case "/todoist/create":
                task = build_task_request(
                    args["content"],
                    args["description"],
                    args["project_id"],
                    args["request_id"],
                    var(env, "TODOIST_API_KEY"),
                )
                created = await todoist.create_task(env, task, budget_ms=args["budget_ms"])
                data = {
                    "result": created.verdict.result,
                    "code": created.verdict.code,
                    "retry_after": created.verdict.retry_after,
                    "task_id": created.task_id,
                }
            case "/todoist/find":
                data = {"ids": await todoist.find_footer_tasks(env, args["event_id"])}
            case "/read-capped":
                data = await read_from_stub(args["chunk"], args["chunks"], args["limit"])
            case _:
                return Response("not found", status=404)
        data["elapsed_ms"] = now_ms() - started
        return Response(json.dumps(data), headers={"content-type": "application/json"})
