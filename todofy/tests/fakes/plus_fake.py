"""Synthetic Todoist Sync + REST v1 subset used by the real Plus runtime tests.

A metadata Sync answers sync_token "*" (or a token this fake never issued) in full and an issued token with the
labels and filters that changed since it, deleted ones with is_deleted, as Todoist's incremental Sync does.
Tasks carry completed_count: closing a task adds one, and a recurring task stays active. The activity log
answers ``activity[task_id]`` (completed, uncompleted and deleted events), or ``activity_status`` when set.
"""

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
        self.sync_tokens = {}  # token -> (labels, filters) by ID as they were when it was issued
        self.activity = {}  # task ID -> its activity log events
        self.activity_status = 200
        self.route("POST", r"/api/v1/sync", self.sync)
        self.route("GET", r"/api/v1/tasks", self.list_tasks)
        self.route("GET", r"/api/v1/tasks/([a-zA-Z0-9_-]+)", self.get_task)
        self.route("GET", r"/api/v1/activities", self.activities)

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
            "completed_count": 0,
            **fields,
        }

    def sync(self, request: Recorded, _match):
        form = parse_qs(request.body.decode())
        commands = json.loads(form.get("commands", ["[]"])[0])
        if not commands:
            return Reply(200, self.metadata(form.get("sync_token", ["*"])[0]))
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
                    self.tasks[task_id]["completed_count"] += 1
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

    def metadata(self, token: str) -> dict:
        labels = {str(row["id"]): deepcopy(row) for row in self.labels}
        filters = {str(row["id"]): deepcopy(row) for row in self.filters}
        issued = f"synthetic-sync-{len(self.sync_tokens) + 1}"
        previous = self.sync_tokens.get(token)
        self.sync_tokens[issued] = (labels, filters)
        if previous is None:
            return {
                "sync_token": issued,
                "full_sync": True,
                "user": {"tz_info": {"timezone": "UTC"}, "api_token": "synthetic-never-return"},
                "labels": list(labels.values()),
                "filters": list(filters.values()),
            }

        def changed(now: dict, then: dict) -> list:
            gone = [{**row, "is_deleted": True} for key, row in then.items() if key not in now]
            return [row for key, row in now.items() if then.get(key) != row] + gone

        return {
            "sync_token": issued,
            "full_sync": False,
            "labels": changed(labels, previous[0]),
            "filters": changed(filters, previous[1]),
        }

    def sync_requests(self) -> list[str]:
        """The sync_token of each metadata Sync, in order."""
        forms = [parse_qs(request.body.decode()) for request in self.received("POST", "/api/v1/sync")]
        return [form.get("sync_token", ["*"])[0] for form in forms if "commands" not in form]

    def list_tasks(self, request: Recorded, _match):
        if request.param("ids") is not None:
            # A lookup by ID is one page of the active tasks among them.
            ids = request.param("ids").split(",")
            return Reply(
                200, {"results": [deepcopy(self.tasks[i]) for i in ids if i in self.tasks], "next_cursor": None}
            )
        start = int(request.param("cursor") or "0")
        limit = min(int(request.param("limit") or 200), 2)
        tasks = list(self.tasks.values())
        end = start + limit
        return Reply(
            200, {"results": deepcopy(tasks[start:end]), "next_cursor": str(end) if end < len(tasks) else None}
        )

    def activities(self, request: Recorded, _match):
        if self.activity_status != 200:
            return Reply(self.activity_status, {"error": "synthetic activity log refusal"})
        assert request.param("object_type") == "item"
        assert json.loads(request.param("object_event_types")) == ["item:completed", "item:uncompleted", "item:deleted"]
        return Reply(200, {"results": deepcopy(self.activity.get(request.param("object_id"), [])), "next_cursor": None})

    def get_task(self, _request, match):
        task = self.tasks.get(match[1])
        return Reply(200, deepcopy(task)) if task else Reply(404, {})

    def commands(self):
        return [
            command
            for request in self.received("POST", "/api/v1/sync")
            for command in json.loads(parse_qs(request.body.decode()).get("commands", ["[]"])[0])
        ]
