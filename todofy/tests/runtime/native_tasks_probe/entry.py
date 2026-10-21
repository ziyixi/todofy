"""Test-only Python caller of the actual Tasks service binding."""

import json
from urllib.parse import urlsplit

import js
from workers import Response, WorkerEntrypoint

from todofy.core.todoist_request import build_task_request
from todofy.runtime import gtd, intents, native_tasks, reminder
from todofy.runtime.coordinator import TodofyCore
from todofy.runtime.interop import to_js


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlsplit(request.url).path
        if path == "/health":
            return Response("ok")
        data = json.loads(await request.text())
        if path == "/native/http":
            source = js.Request.new(
                "https://tasks.internal" + data["path"],
                to_js(
                    {
                        "method": data["method"],
                        "headers": {"content-type": "application/json"},
                        "body": json.dumps(data["body"]),
                    }
                ),
            )
            answer = await self.env.TASKS.fetch(source)
            return Response(await answer.text(), status=answer.status, headers={"content-type": "application/json"})
        if path == "/native/call":
            result = await native_tasks.call(self.env, data["method"], data["body"])
        elif path == "/native/producer":
            result = json.loads(await self.env.PLUS.getByName(data["name"]).produce(json.dumps(data)))
        elif path == "/native/create":
            frozen = build_task_request(
                data["title"],
                data["description"],
                data.get("project_id", ""),
                data["request_id"],
                parent_id=data.get("parent_id", ""),
            )
            created = await native_tasks.create_task(self.env, frozen, budget_ms=1000)
            result = {"result": created.verdict.result, "task_id": created.task_id, "attempts": created.attempts}
        elif path == "/native/find":
            result = {"ids": await native_tasks.find_footer_tasks(self.env, data["event_id"])}
        else:
            return Response("not found", status=404)
        return Response(json.dumps(result), headers={"content-type": "application/json"})


class NativePlusProbe(TodofyCore):
    async def produce(self, text):
        data = json.loads(text)
        env = ProducerEnv(self.env, data.get("vars", {}))
        now = data["now"]
        self.running = True
        try:
            if data["kind"] == "intent_propose":
                result = await intents.propose(env, self, json.dumps(data["intent"]), now)
            elif data["kind"] == "intent_step":
                row = await intents.next_due(env.DB, now)
                if row is not None:
                    await intents.step(env, self, row)
                result = {"stepped": row is not None}
            elif data["kind"] == "reminder":
                result = {"next_at": await reminder.tick(env, self, now)}
            else:
                state = gtd.State(
                    next_collect=now + 86400 if data["kind"] == "review" else 0,
                    next_review=0 if data["kind"] == "review" else now + 86400,
                )
                gtd.save(self.sql, state)
                await gtd.tick(env, self, now)
                result = {"counters": gtd.load(self.sql).counters}
            return json.dumps(result)
        finally:
            self.running = False


class ProducerEnv:
    def __init__(self, original, variables):
        self.original, self.variables = original, variables

    def __getattr__(self, name):
        return self.variables[name] if name in self.variables else getattr(self.original, name)
