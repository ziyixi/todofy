"""Synthetic Todoist Sync + REST v1 subset used by the real Plus runtime tests."""

import json
from copy import deepcopy
from urllib.parse import parse_qs

from tests.fakes.server import FakeServer, Recorded, Reply


class PlusFake(FakeServer):
    def __init__(self):
        super().__init__()
        self.labels = [
            {"id": str(index + 1), "name": role}
            for index, role in enumerate(
                (
                    "office",
                    "home",
                    "bets",
                    "committed",
                    "focus",
                    "candiate",
                    "lead_1d",
                    "lead_3d",
                    "lead_1w",
                    "lead_2w",
                    "lead_1m",
                )
            )
        ]
        self.tasks = {}
        self.filters = [{"id": "filter-bets", "name": "Synthetic Bets", "query": "@bets"}]
        self.receipts = {}
        self.closed = {}
        self.fail_commands_once = False
        self.route("POST", r"/api/v1/sync", self.sync)
        self.route("GET", r"/api/v1/tasks", self.list_tasks)
        self.route("GET", r"/api/v1/tasks/([a-zA-Z0-9_-]+)", self.get_task)

    def add(self, task_id, **fields):
        self.tasks[task_id] = {
            "id": task_id,
            "content": "Synthetic task " + task_id,
            "project_id": "test-project",
            "labels": [],
            "priority": 1,
            "parent_id": None,
            "due": None,
            "deadline": None,
            **fields,
        }

    def sync(self, request: Recorded, _match):
        form = parse_qs(request.body.decode())
        commands = json.loads(form.get("commands", ["[]"])[0])
        if not commands:
            return Reply(
                200,
                {
                    "user": {"tz_info": {"timezone": "UTC"}, "api_token": "synthetic-never-return"},
                    "labels": self.labels,
                    "filters": self.filters,
                },
            )
        statuses, mapping = {}, {}
        for command in commands:
            identity = command["uuid"]
            if identity not in self.receipts:
                args = command["args"]
                if command["type"] == "item_add":
                    task_id = f"child-{len(self.tasks)}"
                    self.add(task_id, **args)
                    self.receipts[identity] = task_id
                elif command["type"] == "item_close":
                    task_id = args["id"]
                    self.closed[task_id] = self.closed.get(task_id, 0) + 1
                    if not (self.tasks[task_id].get("due") or {}).get("is_recurring"):
                        del self.tasks[task_id]
                    self.receipts[identity] = True
                elif command["type"] == "item_update":
                    self.tasks[args["id"]].update(args)
                    self.receipts[identity] = True
                else:
                    raise AssertionError("unexpected command")
            statuses[identity] = "ok"
            if command["type"] == "item_add":
                mapping[command["temp_id"]] = self.receipts[identity]
        if self.fail_commands_once:
            self.fail_commands_once = False
            return Reply(503, {"error": "synthetic response lost after apply"})
        return Reply(200, {"sync_status": statuses, "temp_id_mapping": mapping})

    def list_tasks(self, request: Recorded, _match):
        start = int(request.param("cursor") or "0")
        limit = min(int(request.param("limit") or 200), 2)
        tasks = list(self.tasks.values())
        end = start + limit
        return Reply(
            200, {"results": deepcopy(tasks[start:end]), "next_cursor": str(end) if end < len(tasks) else None}
        )

    def get_task(self, _request, match):
        task = self.tasks.get(match[1])
        return Reply(200, deepcopy(task)) if task else Reply(404, {})

    def commands(self):
        return [
            command
            for request in self.received("POST", "/api/v1/sync")
            for command in json.loads(parse_qs(request.body.decode()).get("commands", ["[]"])[0])
        ]
