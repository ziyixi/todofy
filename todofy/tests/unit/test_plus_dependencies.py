"""Dependencies between tasks (PlusService SetTaskDependency, ResolveDependencies, CompleteTask's record, the Plan's
edges) on host CPython: core/plan.py's cycle and limit rules, and the runtime modules over host SQLite D1.

Todoist is a fake: its REST reads (the active tasks by ID and the activity log) answer through the real
plus_todoist.call, so a 403 from the activity log is seen not to block Todoist; metadata and Sync commands are
replaced as in test_plus_receipts.py. Every ID, title and event is synthetic. The workerd path is
tests/runtime/test_plus_dependencies.py.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from tests.unit.plus_support import D1, Storage, stubbed_pyodide
from todofy.core import plan

NOW = 1_760_000_000
LABELS = ("office", "home", "bets", "committed", "focus", "candiate", "quarter")
LABELS += ("lead_1d", "lead_3d", "lead_1w", "lead_2w", "lead_1m")


# ---- core/plan.py --------------------------------------------------------------------------------------------


def test_waits_for_follows_dependencies_through_other_tasks():
    edges = [("a", "b"), ("b", "c"), ("x", "y")]
    assert plan.waits_for(edges, "a", "c") and plan.waits_for(edges, "a", "b")
    assert not plan.waits_for(edges, "c", "a") and not plan.waits_for(edges, "a", "y")
    # A cycle already in the input (a restore, say) still ends.
    assert not plan.waits_for([("a", "b"), ("b", "a")], "a", "z")


@pytest.mark.parametrize(
    ("edges", "task", "prerequisite", "refusal"),
    [
        pytest.param([], "a", "a", "cycle", id="itself"),
        pytest.param([("b", "a")], "a", "b", "cycle", id="each_other"),
        pytest.param([("c", "b"), ("b", "a")], "a", "c", "cycle", id="through_another"),
        pytest.param([("a", f"p{n}") for n in range(5)], "a", "b", "limit", id="five_per_task"),
        pytest.param([(f"t{n}", "p") for n in range(300)], "a", "b", "limit", id="three_hundred"),
        pytest.param([("a", f"p{n}") for n in range(5)], "a", "p0", None, id="existing_edge_changes_nothing"),
        pytest.param([("b", "c"), ("a", "c")], "a", "b", None, id="shared_prerequisite_is_no_cycle"),
    ],
)
def test_dependency_refusal(edges, task, prerequisite, refusal):
    assert plan.dependency_refusal(edges, task, prerequisite) == refusal


# ---- the runtime over host SQLite --------------------------------------------------------------------------


class Todoist:
    """Active tasks by ID, Sync commands that close tasks, and an activity log; REST reads are journalled."""

    def __init__(self, error: type[Exception]) -> None:
        self.error = error
        self.labels = [{"id": "id-" + role, "name": role} for role in LABELS]
        self.tasks: dict[str, dict[str, Any]] = {}
        self.activity: dict[str, list[dict[str, Any]]] = {}
        self.activity_status = 200
        self.reads: list[str] = []
        self.sent: list[dict[str, Any]] = []

    def add(self, task_id: str, *, recurring: bool = False, count: int | None = 0) -> None:
        task: dict[str, Any] = {"id": task_id, "content": "Synthetic " + task_id, "labels": [], "project_id": "p"}
        if recurring:
            task["due"] = {"date": "2026-10-20", "is_recurring": True}
        if count is not None:
            task["completed_count"] = count
        self.tasks[task_id] = task

    def event(self, task_id: str, event_type: str, day: int) -> None:
        self.activity.setdefault(task_id, []).append(
            {
                "object_type": "item",
                "object_id": task_id,
                "event_type": event_type,
                "event_date": f"2026-10-{day}T09:00:00Z",
            }
        )

    async def metadata(self, _core: Any, *, fresh: bool = False) -> dict[str, Any]:
        return {"timezone": "UTC", "labels": self.labels, "filters": []}

    async def list(self, _core: Any, limit: int = 200, cursor: str = "") -> tuple[list[dict[str, Any]], str]:
        return [dict(task) for task in self.tasks.values()], ""

    async def commands(self, _core: Any, commands: list[dict[str, Any]]) -> dict[str, Any]:
        for command in commands:
            self.sent.append(command)
            task = self.tasks[command["args"]["id"]]
            if command["type"] == "item_close":
                if (task.get("due") or {}).get("is_recurring"):
                    task["completed_count"] += 1
                else:
                    del self.tasks[task["id"]]
        return {"sync_status": {command["uuid"]: "ok" for command in commands}}

    async def fetch(self, url: str, **_options: Any) -> Any:
        from todofy.runtime.interop import Upstream

        parts = urlsplit(url)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        self.reads.append(parts.path)
        if parts.path == "/api/v1/tasks":
            ids = query["ids"].split(",")
            results = [self.tasks[task_id] for task_id in ids if task_id in self.tasks]
            return Upstream(200, json.dumps({"results": results, "next_cursor": None}).encode())
        if parts.path == "/api/v1/activities":
            if self.activity_status != 200:
                return Upstream(self.activity_status, b"{}")
            assert query["object_type"] == "item"
            assert json.loads(query["object_event_types"]) == ["item:completed", "item:uncompleted", "item:deleted"]
            # Todoist's answer may include another task's events; closed_as keeps only its own.
            events = self.activity.get(query["object_id"], []) + self.activity.get("noise", [])
            return Upstream(200, json.dumps({"results": events, "next_cursor": None}).encode())
        raise AssertionError(parts.path)


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        self.d1 = D1()
        self.todoist = Todoist(runtime.todoist.PlusError)
        self.blocked: list[int] = []
        for name in ("metadata", "commands"):
            monkeypatch.setattr(runtime.todoist, name, getattr(self.todoist, name))
        monkeypatch.setattr(runtime.todoist, "tasks", self.todoist.list)
        monkeypatch.setattr(runtime.todoist, "fetch_with_timeout", self.todoist.fetch)
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _timezone: "2026-10-14")
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        storage = Storage([])
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TODOIST_API_KEY="synthetic-key", TODOIST_DEFAULT_PROJECT_ID="mail"),
            plus_lock=asyncio.Lock(),
            todoist_wait=lambda _now: None,
            count_todoist_calls=lambda *_: None,
            block_todoist=self.blocked.append,
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )
        runtime.clock["ms"] = NOW * 1000

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        if method not in ("ReadPlan", "ListPlanningTasks"):
            request.setdefault("request_id", str(uuid.uuid4()))
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request), owner=True))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def wait(self, task_id: str, prerequisite_id: str, *, waits: bool = True) -> dict[str, Any]:
        return self.call("SetTaskDependency", task_id=task_id, prerequisite_id=prerequisite_id, waits=waits)

    def dependencies(self) -> list[dict[str, Any]]:
        return self.call("ReadPlan")["plan"].get("dependencies", [])

    def edges(self) -> list[tuple[str, str, int]]:
        """plan_edges as stored: the two tasks' external IDs (through plan_tasks) and the baseline."""
        rows = self.d1.db.execute(
            "SELECT w.external_id, p.external_id, e.baseline_count, e.kind FROM plan_edges e"
            " JOIN plan_tasks w ON w.id = e.task_id JOIN plan_tasks p ON p.id = e.prerequisite_id ORDER BY e.rowid"
        ).fetchall()
        assert all(row[3] == "waits_for" for row in rows)
        return [(row[0], row[1], row[2]) for row in rows]

    def closed(self) -> dict[str, str | None]:
        return dict(self.d1.db.execute("SELECT external_id, closed_as FROM plan_tasks").fetchall())


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch) as stubs:
        from todofy.runtime import plus_api, plus_receipts
        from todofy.runtime import plus_todoist as todoist

        stack = Stack(
            types.SimpleNamespace(
                plus_api=plus_api, plus_receipts=plus_receipts, todoist=todoist, clock=stubs["clock"]
            ),
            monkeypatch,
        )
        for task_id in ("invite", "venue", "budget", "plan"):
            stack.todoist.add(task_id)
        etag = stack.call("ReadPlan")["plan"]["etag"]
        assert "plan" in stack.call("ConfirmPlanMapping", etag=etag)
        stack.todoist.reads.clear()
        stack.d1.statements.clear()
        yield stack


def test_a_dependency_is_stored_by_todofy_ids_with_one_read_and_no_todoist_write(stack):
    stack.todoist.tasks["venue"]["completed_count"] = 2
    answer = stack.wait("invite", "venue")
    assert answer == {
        "dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "baseline_completed_count": 2}]
    }
    assert stack.todoist.reads == ["/api/v1/tasks"] and stack.todoist.sent == []
    # The settings, every dependency for the cycle check, then one batch: the two identities, the edge, the answer.
    assert len(stack.d1.statements) == 5
    assert stack.edges() == [("invite", "venue", 2)]
    # Both tasks have Todofy IDs; no title or other text is stored.
    assert stack.closed() == {"invite": None, "venue": None}
    assert "Synthetic" not in json.dumps([list(row) for row in stack.d1.db.execute("SELECT * FROM plan_tasks")])
    assert stack.dependencies() == answer["dependencies"]


def test_adding_again_changes_nothing_and_keeps_the_first_baseline(stack):
    stack.wait("invite", "venue")
    stack.todoist.tasks["venue"]["completed_count"] = 7
    stack.todoist.reads.clear()
    assert stack.wait("invite", "venue")["dependencies"][0].get("baseline_completed_count", 0) == 0
    assert stack.todoist.reads == []  # answered from the store
    assert stack.edges() == [("invite", "venue", 0)]


def test_removing_reads_nothing_from_todoist_and_is_idempotent(stack):
    stack.wait("invite", "venue")
    stack.wait("invite", "budget")
    stack.todoist.reads.clear()
    assert stack.wait("invite", "venue", waits=False)["dependencies"] == [
        {"task_id": "invite", "prerequisite_id": "budget"}
    ]
    assert stack.wait("invite", "venue", waits=False)["dependencies"] == [
        {"task_id": "invite", "prerequisite_id": "budget"}
    ]
    assert stack.todoist.reads == [] and stack.edges() == [("invite", "budget", 0)]


@pytest.mark.parametrize(
    ("existing", "task", "prerequisite"),
    [
        pytest.param([("venue", "invite")], "invite", "venue", id="each_other"),
        pytest.param([("venue", "budget"), ("budget", "invite")], "invite", "venue", id="through_another"),
        pytest.param([], "invite", "invite", id="itself"),
    ],
)
def test_the_server_refuses_a_cycle_without_reading_todoist(stack, existing, task, prerequisite):
    for waiter, waited in existing:
        assert "dependencies" in stack.wait(waiter, waited)
    stack.todoist.reads.clear()
    assert stack.wait(task, prerequisite) == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.todoist.reads == [] and len(stack.edges()) == len(existing)


def test_a_task_waits_for_at_most_five(stack):
    for n in range(6):
        stack.todoist.add(f"p{n}")
    for n in range(5):
        assert "dependencies" in stack.wait("invite", f"p{n}")
    assert stack.wait("invite", "p5") == {"error": "ACTION_NOT_ALLOWED"}


def test_a_closed_task_cannot_be_waited_for_or_wait(stack):
    assert stack.wait("invite", "gone") == {"error": "NOT_FOUND"}
    assert stack.wait("gone", "venue") == {"error": "NOT_FOUND"}
    assert stack.edges() == [] and stack.closed() == {}


def test_a_recurring_prerequisite_needs_todoists_counter(stack):
    stack.todoist.add("weekly", recurring=True, count=4)
    stack.todoist.add("monthly", recurring=True, count=None)
    assert stack.wait("invite", "weekly")["dependencies"][0]["baseline_completed_count"] == 4
    assert stack.wait("plan", "monthly") == {"error": "ACTION_NOT_ALLOWED"}
    # The view carries what the extension needs for the rule: recurring, and the counter when Todoist gives one.
    tasks = {task["id"]: task for task in stack.call("ListPlanningTasks")["planning_tasks"]}
    assert tasks["weekly"]["recurring"] is True and tasks["weekly"]["completed_count"] == 4
    assert tasks["monthly"]["recurring"] is True and "completed_count" not in tasks["monthly"]
    assert "recurring" not in tasks["venue"] and tasks["venue"].get("completed_count", 0) == 0


def test_dependency_writes_need_plus_enabled(stack):
    stack.d1.db.execute("UPDATE plus_settings SET enabled = 0")
    stack.d1.db.commit()
    assert stack.wait("invite", "venue") == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.call("ResolveDependencies", task_ids=["venue"]) == {"error": "ACTION_NOT_ALLOWED"}


def test_maintenance_holds_dependency_writes(stack):
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.wait("invite", "venue") == {"error": "MAINTENANCE"}
    assert stack.call("ResolveDependencies", task_ids=["venue"]) == {"error": "MAINTENANCE"}


def test_the_basic_view_has_no_dependencies(stack):
    stack.wait("invite", "venue")
    assert "dependencies" not in stack.call("ReadPlan", view="basic")["plan"]
    assert len(stack.call("ReadPlan", view="full")["plan"]["dependencies"]) == 1


def test_completing_a_prerequisite_in_plus_records_it_completed_and_keeps_the_dependency(stack):
    stack.wait("invite", "venue")
    assert stack.call("CompleteTask", task_id="venue") == {"task_id": "venue"}
    assert stack.closed()["venue"] == "completed"
    assert stack.dependencies() == [{"task_id": "invite", "prerequisite_id": "venue", "done": True}]
    # A complete read no longer lists the venue; settling it needs no activity read.
    stack.todoist.reads.clear()
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "done": True}]}
    assert stack.todoist.reads == ["/api/v1/tasks"]


def test_completing_the_waiting_task_drops_its_dependencies_once_it_is_gone(stack):
    stack.wait("invite", "venue")
    stack.wait("budget", "invite")
    stack.call("CompleteTask", task_id="invite")
    # Still listed until the extension's complete read misses the invite and asks.
    assert len(stack.edges()) == 2
    stack.todoist.reads.clear()
    answer = stack.call("ResolveDependencies", task_ids=["invite"])
    # What the invite waited for is gone; the budget still waits for it, satisfied as completed.
    assert answer == {"dependencies": [{"task_id": "budget", "prerequisite_id": "invite", "done": True}]}
    assert stack.todoist.reads == ["/api/v1/tasks"]


def test_a_recurring_task_completed_in_plus_keeps_what_it_waits_for(stack):
    stack.todoist.add("weekly", recurring=True, count=1)
    stack.wait("weekly", "venue")
    stack.call("CompleteTask", task_id="weekly")
    assert stack.call("ResolveDependencies", task_ids=["weekly"])["dependencies"] == [
        {"task_id": "weekly", "prerequisite_id": "venue"}
    ]


@pytest.mark.parametrize(
    ("events", "closed_as", "dropped"),
    [
        pytest.param([("completed", 10)], "completed", False, id="completed"),
        pytest.param([("completed", 10), ("uncompleted", 11), ("completed", 12)], "completed", False, id="again"),
        pytest.param([("completed", 10), ("deleted", 12)], "deleted", True, id="deleted_after"),
        pytest.param([], "deleted", True, id="no_record"),
    ],
)
def test_a_prerequisite_closed_in_todoist_is_settled_from_the_activity_log(stack, events, closed_as, dropped):
    stack.wait("invite", "venue")
    stack.wait("budget", "venue")
    for event_type, day in events:
        stack.todoist.event("venue", event_type, day)
    # Another task's newer deletion, which Todoist may list too, is not this task's.
    stack.todoist.event("noise", "deleted", 15)
    del stack.todoist.tasks["venue"]
    stack.todoist.reads.clear()
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert stack.closed()["venue"] == closed_as
    if dropped:
        assert answer == {"dropped_task_ids": ["invite", "budget"]} and stack.edges() == []
    else:
        assert [edge["done"] for edge in answer["dependencies"]] == [True, True]
        assert "dropped_task_ids" not in answer
    assert stack.todoist.reads == ["/api/v1/tasks", "/api/v1/activities"]
    # Settled once: asking again reads the active list only, or nothing once no dependency names the task.
    stack.todoist.reads.clear()
    stack.call("ResolveDependencies", task_ids=["venue"])
    assert stack.todoist.reads == ([] if dropped else ["/api/v1/tasks"])


def test_a_task_todoist_still_lists_is_left_as_it_is(stack):
    stack.wait("invite", "venue")
    stack.todoist.reads.clear()
    answer = stack.call("ResolveDependencies", task_ids=["venue", "invite", "unknown"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue"}]}
    # Only the tasks with dependencies are read; none is closed, so there is no activity read.
    assert stack.todoist.reads == ["/api/v1/tasks"] and stack.closed() == {"invite": None, "venue": None}


def test_an_unread_activity_log_changes_nothing_and_never_blocks_todoist(stack):
    stack.wait("invite", "venue")
    del stack.todoist.tasks["venue"]
    stack.todoist.activity_status = 403  # a plan without the activity log
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue"}]}
    assert stack.blocked == [] and stack.closed()["venue"] is None
    stack.todoist.activity_status = 503
    assert "dependencies" in stack.call("ResolveDependencies", task_ids=["venue"])
    assert stack.closed()["venue"] is None


def test_a_call_names_at_most_twenty_tasks_and_reads_at_most_ten_logs(stack):
    assert stack.call("ResolveDependencies", task_ids=[f"t{n}" for n in range(21)]) == {"error": "BAD_REQUEST"}
    assert stack.call("ResolveDependencies", task_ids=[]) == {"error": "BAD_REQUEST"}
    ids = [f"p{n}" for n in range(12)]
    for task_id in ids:
        stack.todoist.add(task_id)
        stack.todoist.add("w" + task_id)
        stack.wait("w" + task_id, task_id)
        del stack.todoist.tasks[task_id]
    stack.todoist.reads.clear()
    stack.d1.statements.clear()
    answer = stack.call("ResolveDependencies", task_ids=ids)
    assert stack.todoist.reads.count("/api/v1/activities") == 10
    assert len(answer["dropped_task_ids"]) == 10 and len(answer["dependencies"]) == 2
    # The roles read, the settings read and one batch of at most six.
    assert len(stack.d1.statements) <= 8


def test_a_reopened_task_linked_again_is_open_again(stack):
    stack.wait("invite", "venue")
    stack.call("CompleteTask", task_id="venue")
    stack.todoist.add("venue")  # reopened in Todoist
    stack.wait("budget", "venue")
    assert stack.closed()["venue"] is None
    assert [edge.get("done", False) for edge in stack.dependencies()] == [False, False]
