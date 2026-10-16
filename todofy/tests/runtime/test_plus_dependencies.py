"""Dependencies through the real gateway, Python Durable Object and D1 with the extension's token: stored as
plan_edges between Todofy's own task IDs, never written to Todoist, satisfied by a recurring prerequisite's
next completion, and settled from Todoist's active list and activity log. All upstream data is synthetic."""

import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from tests.fakes.plus_fake import PlusFake
from tests.runtime.harness import CSRF_SIGNING_KEY, Worker, reason, start_gateway


@dataclass
class Stack:
    worker: Worker
    upstream: PlusFake
    token: str

    def post(self, path, **body):
        return self.worker.hooks.post(
            f"/api/plus/v1/{path}",
            json={"request_id": str(uuid.uuid4()), **body},
            headers={"authorization": "Bearer " + self.token},
        )

    def wait(self, task_id, prerequisite_id, waits=True):
        return self.post("tasks:setTaskDependency", task_id=task_id, prerequisite_id=prerequisite_id, waits=waits)

    def resolve(self, *task_ids):
        response = self.post("tasks:resolveDependencies", task_ids=list(task_ids))
        assert response.status_code == 200, response.text
        return response.json()

    def plan(self, view=None):
        response = self.worker.hooks.get(
            "/api/plus/v1/plan:read",
            params={"view": view} if view else None,
            headers={"authorization": "Bearer " + self.token},
        )
        assert response.status_code == 200, response.text
        return response.json()["plan"]

    def dependencies(self):
        return {(edge["task_id"], edge["prerequisite_id"]): edge for edge in self.plan().get("dependencies", [])}

    def tasks(self):
        response = self.worker.hooks.get(
            "/api/plus/v1/tasks", params={"page_size": 200}, headers={"authorization": "Bearer " + self.token}
        )
        assert response.status_code == 200, response.text
        records = response.json().get("planning_tasks", [])
        while token := response.json().get("next_page_token"):
            response = self.worker.hooks.get(
                "/api/plus/v1/tasks",
                params={"page_size": 200, "page_token": token},
                headers={"authorization": "Bearer " + self.token},
            )
            records += response.json().get("planning_tasks", [])
        return {task["id"]: task for task in records}


@pytest.fixture(scope="module")
def stack(tmp_path_factory) -> Iterator[Stack]:
    upstream = PlusFake()
    for task_id in ("invite", "venue", "budget", "shelf", "books"):
        upstream.add(task_id)
    upstream.add("weekly", due={"date": "2026-10-20", "is_recurring": True}, completed_count=3)
    process = start_gateway(
        tmp_path_factory.mktemp("plus-dependencies"),
        {
            "TODOIST_API_BASE": upstream.url,
            "TODOIST_API_KEY": "synthetic-plus-key",
            "PROCESSING_PAUSED": "true",
            "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
        },
    )
    try:
        worker = next(process)
        plan = worker.owner.get("/api/plus/v1/plan:read").json()["plan"]
        confirmed = worker.post_owner(
            "/api/plus/v1/plan:confirmPlanMapping", {"etag": plan["etag"], "request_id": str(uuid.uuid4())}
        )
        assert confirmed.status_code == 200, confirmed.text
        issued = worker.post_owner(
            "/api/plus/v1/connections:issueExtensionConnection",
            {"display_name": "Synthetic Chrome", "request_id": str(uuid.uuid4())},
        )
        assert issued.status_code == 200, issued.text
        yield Stack(worker, upstream, issued.json()["token"])
    finally:
        process.close()
        upstream.close()


def test_a_dependency_lives_in_d1_by_todofy_ids_and_never_reaches_todoist(stack):
    commands = len(stack.upstream.commands())
    added = stack.wait("invite", "venue")
    assert added.status_code == 200, added.text
    assert added.json() == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue"}]}
    assert stack.dependencies() == {("invite", "venue"): {"task_id": "invite", "prerequisite_id": "venue"}}
    assert len(stack.upstream.commands()) == commands  # no Todoist write of any kind
    tasks = stack.worker.d1("SELECT id, provider, external_id, closed_as FROM plan_tasks ORDER BY id")
    assert [(row["provider"], row["external_id"]) for row in tasks] == [("todoist", "invite"), ("todoist", "venue")]
    edges = stack.worker.d1("SELECT task_id, prerequisite_id, kind, baseline_count FROM plan_edges")
    assert edges == [
        {"task_id": tasks[0]["id"], "prerequisite_id": tasks[1]["id"], "kind": "waits_for", "baseline_count": 0}
    ]
    # The native page's view leaves them out.
    assert "dependencies" not in stack.plan("basic")
    removed = stack.wait("invite", "venue", waits=False)
    assert removed.status_code == 200 and removed.json() == {}
    assert stack.dependencies() == {} and stack.worker.d1("SELECT count(*) AS n FROM plan_edges") == [{"n": 0}]


def test_a_cycle_and_a_closed_task_are_refused(stack):
    assert stack.wait("budget", "shelf").status_code == 200
    assert reason(stack.wait("shelf", "budget")) == "ACTION_NOT_ALLOWED"
    assert reason(stack.wait("budget", "budget")) == "ACTION_NOT_ALLOWED"
    assert reason(stack.wait("budget", "never-active")) == "NOT_FOUND"
    assert set(stack.dependencies()) == {("budget", "shelf")}
    stack.wait("budget", "shelf", waits=False)


def test_a_recurring_prerequisite_is_satisfied_by_its_next_completion(stack):
    added = stack.wait("books", "weekly")
    assert added.json()["dependencies"][0]["baseline_completed_count"] == 3
    weekly = stack.tasks()["weekly"]
    assert weekly["recurring"] is True and weekly["completed_count"] == 3
    completed = stack.post("tasks:completeTask", task_id="weekly")
    assert completed.status_code == 200, completed.text
    # Still active, one more completion: the extension compares the counter with the baseline.
    weekly = stack.tasks()["weekly"]
    assert weekly["completed_count"] == 4 > stack.dependencies()[("books", "weekly")]["baseline_completed_count"]
    # Todofy recorded the completion; a complete read still lists the task, so nothing is settled.
    assert stack.dependencies()[("books", "weekly")]["done"] is True
    assert set((edge["task_id"], edge["prerequisite_id"]) for edge in stack.resolve("weekly")["dependencies"]) == {
        ("books", "weekly")
    }
    stack.wait("books", "weekly", waits=False)


def test_prerequisites_closed_in_todoist_are_settled_from_the_activity_log(stack):
    for waiter, prerequisite in (("invite", "venue"), ("books", "shelf")):
        assert stack.wait(waiter, prerequisite).status_code == 200
    # Completed and deleted in native Todoist: gone from the active list.
    del stack.upstream.tasks["venue"], stack.upstream.tasks["shelf"]
    stack.upstream.activity = {
        "venue": [
            {
                "object_type": "item",
                "object_id": "venue",
                "event_type": "completed",
                "event_date": "2026-10-15T08:00:00Z",
            }
        ],
        "shelf": [
            {
                "object_type": "item",
                "object_id": "shelf",
                "event_type": "completed",
                "event_date": "2026-10-14T08:00:00Z",
            },
            {
                "object_type": "item",
                "object_id": "shelf",
                "event_type": "deleted",
                "event_date": "2026-10-15T08:00:00Z",
            },
        ],
    }
    answer = stack.resolve("venue", "shelf")
    assert answer == {
        "dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "done": True}],
        "dropped_task_ids": ["books"],
    }
    closed = {
        row["external_id"]: row["closed_as"] for row in stack.worker.d1("SELECT external_id, closed_as FROM plan_tasks")
    }
    assert closed["venue"] == "completed" and closed["shelf"] == "deleted"
    # Settled once: no further activity read.
    reads = len(stack.upstream.received("GET", "/api/v1/activities"))
    assert stack.resolve("venue", "shelf") == {
        "dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "done": True}]
    }
    assert len(stack.upstream.received("GET", "/api/v1/activities")) == reads
    # The waiting task completes in Plus; the next check drops what it waited for.
    assert stack.post("tasks:completeTask", task_id="invite").status_code == 200
    assert stack.resolve("invite") == {}


@pytest.mark.parametrize("status", [403, 503])
def test_an_unreadable_activity_log_leaves_the_prerequisite_and_never_blocks_todoist(stack, status):
    stack.upstream.add(f"s{status}")
    stack.upstream.add(f"w{status}")
    assert stack.wait(f"w{status}", f"s{status}").status_code == 200
    del stack.upstream.tasks[f"s{status}"]
    stack.upstream.activity_status = status
    try:
        answer = stack.resolve(f"s{status}")
    finally:
        stack.upstream.activity_status = 200
    assert {(edge["task_id"], edge["prerequisite_id"]) for edge in answer.get("dependencies", [])} == {
        (f"w{status}", f"s{status}")
    }
    assert "dropped_task_ids" not in answer
    # Todoist is not blocked for six hours: the next call reads it, and settles this time.
    assert stack.resolve(f"s{status}") == {"dropped_task_ids": [f"w{status}"]}
    assert f"w{status}" in stack.tasks()
