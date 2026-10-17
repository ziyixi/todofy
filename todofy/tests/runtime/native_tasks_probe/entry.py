"""Test-only Python caller of the actual Tasks service binding."""

import json
from urllib.parse import urlsplit

from workers import DurableObject, Response, WorkerEntrypoint

from todofy.core.todoist_request import build_task_request
from todofy.runtime import native_plus, native_tasks, todoist


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlsplit(request.url).path
        if path == "/health":
            return Response("ok")
        data = json.loads(await request.text())
        if path == "/native/call":
            result = await native_tasks.call(self.env, data["method"], data["body"])
        elif path == "/native/plus":
            result = json.loads(await self.env.PLUS.getByName("native-plus-test").run(json.dumps(data)))
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


class NativePlusProbe(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        self.sql.exec(native_plus.SCHEMA)

    async def run(self, text):
        data = json.loads(text)
        try:
            result = await native_plus.commands(self, data["commands"])
        except native_tasks.NativeTasksError as error:
            result = {"error": error.status}
        return json.dumps(result)
