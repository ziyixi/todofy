"""Test-only Worker that calls the upstream clients directly (never shipped).

`tests/runtime/clients_probe/__init__.py` stages it next to a copy of
`worker/todofy`, so the clients run in real workerd without the ledger around
them. Each route takes JSON arguments (``vars`` overrides Worker vars for that
call) and answers the client's result as JSON.
"""

import json
from typing import Any
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint

from todofy.core.todoist_request import build_task_request
from todofy.runtime import gemini, todoist
from todofy.runtime.config import var
from todofy.runtime.interop import now_ms


class Overlay:
    """The Worker env with some vars replaced, so one probe serves every scenario."""

    def __init__(self, env: Any, overrides: dict[str, str]) -> None:
        self._env = env
        self._overrides = overrides

    def __getattr__(self, name: str) -> Any:
        return self._overrides[name] if name in self._overrides else getattr(self._env, name)


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
                )
                data = {
                    "ok": result.verdict.ok,
                    "code": result.verdict.code,
                    "next_model": result.verdict.next_model,
                    "retry_after": result.verdict.retry_after,
                    "text": result.text,
                    "model": result.model,
                    "tokens": result.tokens,
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
            case _:
                return Response("not found", status=404)
        data["elapsed_ms"] = now_ms() - started
        return Response(json.dumps(data), headers={"content-type": "application/json"})
