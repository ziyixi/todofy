"""Test-only Python caller of the actual Tasks service binding."""

import json
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint

from todofy.core.todoist_request import build_task_request
from todofy.runtime import gtd, intents, native_plan, native_plus, native_tasks, plus_week, reminder, todoist
from todofy.runtime.coordinator import TodofyCore


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlsplit(request.url).path
        if path == "/health":
            return Response("ok")
        data = json.loads(await request.text())
        if path == "/native/call":
            result = await native_tasks.call(self.env, data["method"], data["body"])
        elif path == "/native/producer":
            result = json.loads(await self.env.PLUS.getByName(data["name"]).produce(json.dumps(data)))
        elif path == "/native/plus":
            result = json.loads(await self.env.PLUS.getByName("native-plus-test").run(json.dumps(data)))
        elif path == "/native/plan":
            answer = await self.env.PLUS.getByName("native-plus-test").plus_native_ui(
                data["method"], json.dumps(data.get("body", {}))
            )
            text = getattr(answer, "ok", None)
            result = json.loads(text) if text is not None else {"error": answer.error}
        elif path == "/native/reset-week":
            result = {"complete": await self.env.PLUS.getByName("native-plus-test").reset_week(data["week"])}
        elif path == "/native/state":
            if data["action"] == "ready":
                result = {"ready": await native_plan.ready(self.env)}
            elif data["action"] == "overlay":
                result = {"tasks": await native_plan.read_overlay(self.env, data["tasks"])}
            else:
                try:
                    revision = await native_plan.save_state(
                        self.env, data["task_id"], data["labels"], data["expected_rev"], data["request_id"]
                    )
                    result = {"revision": revision}
                except native_tasks.NativeTasksError as error:
                    result = {"error": error.status}
        elif path == "/native/create":
            frozen = build_task_request(
                data["title"],
                data["description"],
                data.get("project_id", ""),
                data["request_id"],
                "unused",
                parent_id=data.get("parent_id", ""),
            )
            created = await todoist.create_task(self.env, frozen, budget_ms=1000)
            result = {"result": created.verdict.result, "task_id": created.task_id, "attempts": created.attempts}
        elif path == "/native/find":
            result = {"ids": await todoist.find_footer_tasks(self.env, data["event_id"])}
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

    async def reset_week(self, week):
        return await plus_week.reset_ended(self, week, native_plan.CANONICAL_MAPPING)

    async def run(self, text):
        data = json.loads(text)
        try:
            result = await native_plus.resume(self, data["commands"])
        except native_tasks.NativeTasksError as error:
            result = {"error": error.status}
        return json.dumps(result)


class ProducerEnv:
    def __init__(self, original, variables):
        self.original, self.variables = original, variables

    def __getattr__(self, name):
        return self.variables[name] if name in self.variables else getattr(self.original, name)
