"""Dependencies between tasks (PlusService SetTaskDependency, ResolveDependencies, CompleteTask's record, the Plan's
edges) on host CPython: core/plan.py's cycle and limit rules, and the runtime modules over host SQLite D1.

Tasks is the fake of plus_support.py, reached through the real native_tasks.call; every ID and title is
synthetic. The workerd path is tests/runtime/test_clients_native_tasks.py.
"""

import asyncio
import json
import types
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.plus_support import D1, NativeTasks, Storage, plan_ready, stubbed_pyodide
from todofy.core import plan

NOW = 1_760_000_000
WEEK = "2026-10-12"
# One read of the open tasks: the catalog it is shown with, then the page.
READ = ["GetCatalog", "ListTasks"]


# ---- core/plan.py --------------------------------------------------------------------------------------------


def test_waits_for_follows_dependencies_through_other_tasks():
    edges = [("a", "b"), ("b", "c"), ("x", "y"), ("a", "d")]
    assert plan.waits_for(edges, "a", "c") and plan.waits_for(edges, "a", "b")
    assert not plan.waits_for(edges, "c", "a") and not plan.waits_for(edges, "a", "y")
    assert plan.prerequisites(edges, "a") == ["b", "d", "c"]  # each once, the nearest first
    # A cycle already in the input (a restore, say) still ends.
    assert not plan.waits_for([("a", "b"), ("b", "a")], "a", "z")


FIVE = [("a", f"p{n}") for n in range(5)]
OTHERS = [(f"t{n}", "p") for n in range(299)]


@pytest.mark.parametrize(
    ("edges", "done", "task", "prerequisite", "expected"),
    [
        pytest.param([], [], "a", "a", ("cycle", None), id="itself"),
        pytest.param([("b", "a")], [], "a", "b", ("cycle", None), id="each_other"),
        pytest.param([("c", "b"), ("b", "a")], [], "a", "c", ("cycle", None), id="through_another"),
        pytest.param([("b", "a")], [("b", "a")], "a", "b", (None, None), id="a_done_one_closes_no_cycle"),
        pytest.param(FIVE, [], "a", "b", ("limit", None), id="five_per_task"),
        pytest.param(FIVE, [("a", "p3"), ("a", "p1")], "a", "b", (None, ("a", "p1")), id="oldest_done_gives_way"),
        pytest.param([*OTHERS, ("x", "p")], [], "a", "b", ("limit", None), id="three_hundred"),
        pytest.param([*OTHERS, ("a", "q")], [("a", "q")], "a", "b", (None, ("a", "q")), id="300_with_a_done_one"),
        pytest.param(FIVE, [("a", "p0")], "a", "p0", (None, None), id="a_done_one_starts_over_in_its_row"),
        pytest.param([("b", "c"), ("a", "c")], [], "a", "b", (None, None), id="shared_prerequisite_is_no_cycle"),
    ],
)
def test_check_dependency(edges, done, task, prerequisite, expected):
    holding = [edge for edge in edges if edge not in done]
    assert plan.check_dependency(edges, holding, task, prerequisite) == expected


# ---- the runtime over host SQLite --------------------------------------------------------------------------


class Stack:
    def __init__(self, runtime: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        self.runtime = runtime
        self.d1 = D1()
        self.tasks = NativeTasks()
        monkeypatch.setattr(runtime.plus_api, "account_day", lambda _timezone: "2026-10-14")
        monkeypatch.setattr(runtime.plus_api.backup, "holds_ledger", lambda *_: False)
        storage = Storage([])
        for statement in runtime.plus_receipts.DO_SCHEMA:
            storage.sql.exec(statement)
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TASKS=self.tasks),
            plus_lock=asyncio.Lock(),
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )
        runtime.clock["ms"] = NOW * 1000

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        if method not in ("ReadPlan", "ListPlanningTasks"):
            request.setdefault("request_id", str(uuid.uuid4()))
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def complete(self, task_id: str) -> dict[str, Any]:
        """CompleteTask from Plan, which shows the task first (ListPlanningTasks gives its etag)."""
        return self.call("CompleteTask", task_id=task_id)

    def wait(self, task_id: str, prerequisite_id: str, *, waits: bool = True) -> dict[str, Any]:
        return self.call("SetTaskDependency", task_id=task_id, prerequisite_id=prerequisite_id, waits=waits)

    def reads(self) -> list[str]:
        methods = self.tasks.methods()
        self.tasks.calls.clear()
        return methods

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

        stack = Stack(
            types.SimpleNamespace(plus_api=plus_api, plus_receipts=plus_receipts, clock=stubs["clock"]), monkeypatch
        )
        for task_id in ("invite", "venue", "budget", "plan"):
            stack.tasks.add(task_id)
        plan_ready(stack.d1, timezone="UTC", week=WEEK)
        stack.d1.statements.clear()
        yield stack


def test_a_dependency_is_stored_by_todofy_ids_with_one_read_and_no_task_write(stack):
    stack.tasks.tasks["venue"]["completed_count"] = 2
    answer = stack.wait("invite", "venue")
    assert answer == {
        "dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "baseline_completed_count": 2}]
    }
    assert stack.reads() == READ
    # The settings, every dependency for the cycle check, the planning state of the page read, then one batch: the
    # two identities, the edge, the answer.
    assert len(stack.d1.statements) == 6
    assert stack.edges() == [("invite", "venue", 2)]
    # Both tasks have Todofy IDs; no title or other text is stored.
    assert stack.closed() == {"invite": None, "venue": None}
    assert "Synthetic" not in json.dumps([list(row) for row in stack.d1.db.execute("SELECT * FROM plan_tasks")])
    assert stack.dependencies() == answer["dependencies"]


def test_adding_again_changes_nothing_and_keeps_the_first_baseline(stack):
    stack.wait("invite", "venue")
    stack.tasks.tasks["venue"]["completed_count"] = 7
    stack.reads()
    stack.d1.statements.clear()
    assert stack.wait("invite", "venue")["dependencies"][0].get("baseline_completed_count", 0) == 0
    # One read tells that it still holds; the store is not written.
    assert stack.reads() == READ and len(stack.d1.statements) == 3
    assert stack.edges() == [("invite", "venue", 0)]


def test_removing_reads_no_task_and_is_idempotent(stack):
    stack.wait("invite", "venue")
    stack.wait("invite", "budget")
    stack.reads()
    assert stack.wait("invite", "venue", waits=False)["dependencies"] == [
        {"task_id": "invite", "prerequisite_id": "budget"}
    ]
    assert stack.wait("invite", "venue", waits=False)["dependencies"] == [
        {"task_id": "invite", "prerequisite_id": "budget"}
    ]
    assert stack.reads() == [] and stack.edges() == [("invite", "budget", 0)]


@pytest.mark.parametrize(
    ("existing", "task", "prerequisite"),
    [
        pytest.param([("venue", "invite")], "invite", "venue", id="each_other"),
        pytest.param([("venue", "budget"), ("budget", "invite")], "invite", "venue", id="through_another"),
        pytest.param([], "invite", "invite", id="itself"),
    ],
)
def test_the_server_refuses_a_cycle_after_one_read(stack, existing, task, prerequisite):
    for waiter, waited in existing:
        assert "dependencies" in stack.wait(waiter, waited)
    stack.reads()
    assert stack.wait(task, prerequisite) == {"error": "ACTION_NOT_ALLOWED"}
    assert stack.reads() == READ and len(stack.edges()) == len(existing)


def test_done_dependencies_neither_count_toward_the_limit_nor_close_a_cycle(stack):
    """Review finding: five completed prerequisites used to fill the task for good, and a satisfied recurring one
    refused a real dependency as a cycle."""
    for n in range(6):
        stack.tasks.add(f"p{n}")
    for n in range(5):
        assert "dependencies" in stack.wait("invite", f"p{n}")
    for n in (3, 1):
        stack.complete(f"p{n}")
    stack.d1.statements.clear()
    answer = stack.wait("invite", "p5")
    # The oldest done one (p1) gave way in the same batch: still five rows, four of them holding.
    assert [edge["prerequisite_id"] for edge in answer["dependencies"]] == ["p0", "p2", "p3", "p4", "p5"]
    assert len(stack.d1.statements) == 7
    stack.tasks.add("p6")
    assert "dependencies" in stack.wait("invite", "p6")  # p3 gives way
    stack.tasks.add("p7")
    assert stack.wait("invite", "p7") == {"error": "ACTION_NOT_ALLOWED"}  # five that hold
    # A waits for the recurring R; R's next completion satisfies it, so R may now wait for A.
    stack.tasks.add("weekly", recurring=True, completed_count=4)
    assert "dependencies" in stack.wait("budget", "weekly")
    assert stack.wait("weekly", "budget") == {"error": "ACTION_NOT_ALLOWED"}
    stack.tasks.tasks["weekly"]["completed_count"] = 5
    assert "dependencies" in stack.wait("weekly", "budget")


def test_a_satisfied_recurring_prerequisite_starts_over_when_added_again(stack):
    stack.tasks.add("weekly", recurring=True, completed_count=4)
    stack.wait("invite", "weekly")
    stack.tasks.tasks["weekly"]["completed_count"] = 5
    answer = stack.wait("invite", "weekly")
    assert answer == {
        "dependencies": [{"task_id": "invite", "prerequisite_id": "weekly", "baseline_completed_count": 5}]
    }
    assert stack.edges() == [("invite", "weekly", 5)]


def test_a_task_waits_for_at_most_five(stack):
    for n in range(6):
        stack.tasks.add(f"p{n}")
    for n in range(5):
        assert "dependencies" in stack.wait("invite", f"p{n}")
    assert stack.wait("invite", "p5") == {"error": "ACTION_NOT_ALLOWED"}


def test_a_closed_task_cannot_be_waited_for_or_wait(stack):
    assert stack.wait("invite", "gone") == {"error": "NOT_FOUND"}
    assert stack.wait("gone", "venue") == {"error": "NOT_FOUND"}
    assert stack.edges() == [] and stack.closed() == {}


def test_a_recurring_prerequisite_waits_from_its_completion_counter(stack):
    stack.tasks.add("weekly", recurring=True, completed_count=4)
    assert stack.wait("invite", "weekly")["dependencies"][0]["baseline_completed_count"] == 4
    # The view carries what Plan needs for the rule: recurring, and the counter.
    tasks = {task["id"]: task for task in stack.call("ListPlanningTasks")["planning_tasks"]}
    assert tasks["weekly"]["recurring"] is True and tasks["weekly"]["completed_count"] == 4
    assert "recurring" not in tasks["venue"] and tasks["venue"].get("completed_count", 0) == 0


def test_dependency_writes_need_planning_enabled(stack):
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


def test_completing_a_prerequisite_in_plan_records_it_completed_and_keeps_the_dependency(stack):
    stack.wait("invite", "venue")
    assert stack.complete("venue") == {"task_id": "venue"}
    assert stack.closed()["venue"] == "completed"
    assert stack.dependencies() == [{"task_id": "invite", "prerequisite_id": "venue", "done": True}]
    # A complete read no longer lists the venue; settling it needs no read of the task itself.
    stack.reads()
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "done": True}]}
    assert stack.reads() == READ


def test_completing_the_waiting_task_drops_its_dependencies_once_it_is_gone(stack):
    stack.wait("invite", "venue")
    stack.wait("budget", "invite")
    stack.complete("invite")
    # Still listed until Plan's complete read misses the invite and asks.
    assert len(stack.edges()) == 2
    stack.reads()
    answer = stack.call("ResolveDependencies", task_ids=["invite"])
    # What the invite waited for is gone; the budget still waits for it, satisfied as completed.
    assert answer == {"dependencies": [{"task_id": "budget", "prerequisite_id": "invite", "done": True}]}
    assert stack.reads() == READ


def test_a_recurring_task_completed_in_plan_keeps_what_it_waits_for(stack):
    stack.tasks.add("weekly", recurring=True, completed_count=1)
    stack.wait("weekly", "venue")
    stack.complete("weekly")
    assert stack.tasks.tasks["weekly"]["completed_count"] == 2
    assert stack.call("ResolveDependencies", task_ids=["weekly"])["dependencies"] == [
        {"task_id": "weekly", "prerequisite_id": "venue"}
    ]


@pytest.mark.parametrize(
    ("closing", "closed_as", "told"),
    [
        pytest.param("completed", "completed", None, id="completed"),
        pytest.param("deleted", "deleted", "dropped_task_ids", id="deleted"),
        # Not listed, but neither completed nor gone (in an archived project, say): the dependencies go with a
        # notice that claims neither, and nothing is recorded.
        pytest.param("archived", None, "released_task_ids", id="not_listed"),
    ],
)
def test_a_prerequisite_closed_in_tasks_is_settled_from_one_read_of_it(stack, closing, closed_as, told):
    stack.wait("invite", "venue")
    stack.wait("budget", "venue")
    if closing == "deleted":
        del stack.tasks.tasks["venue"]
    else:
        stack.tasks.tasks["venue"][closing] = True
    stack.reads()
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert stack.closed()["venue"] == closed_as
    if told:
        assert answer == {told: ["invite", "budget"]} and stack.edges() == []
    else:
        assert [edge["done"] for edge in answer["dependencies"]] == [True, True]
        assert "dropped_task_ids" not in answer and "released_task_ids" not in answer
    assert stack.reads() == [*READ, "GetCatalog", "GetTask"]
    # Settled once: asking again reads the open list only, or nothing once no dependency names the task.
    stack.call("ResolveDependencies", task_ids=["venue"])
    assert stack.reads() == ([] if told else READ)


def test_a_task_tasks_still_lists_is_left_as_it_is(stack):
    stack.wait("invite", "venue")
    stack.reads()
    answer = stack.call("ResolveDependencies", task_ids=["venue", "invite", "unknown"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue"}]}
    # Only the tasks with dependencies are read; none is closed, so no task is read on its own.
    assert stack.reads() == READ and stack.closed() == {"invite": None, "venue": None}


def test_a_failed_read_of_a_gone_task_changes_nothing(stack):
    stack.wait("invite", "venue")
    stack.wait("budget", "plan")
    del stack.tasks.tasks["venue"], stack.tasks.tasks["plan"]
    stack.tasks.failures["GetTask"] = [503]
    answer = stack.call("ResolveDependencies", task_ids=["venue", "plan"])
    assert len(answer["dependencies"]) == 2 and stack.closed()["venue"] is None
    # The next check settles both.
    answer = stack.call("ResolveDependencies", task_ids=["venue", "plan"])
    assert sorted(answer["dropped_task_ids"]) == ["budget", "invite"]


def test_a_call_names_at_most_twenty_tasks_and_reads_at_most_ten_gone_ones(stack):
    assert stack.call("ResolveDependencies", task_ids=[f"t{n}" for n in range(21)]) == {"error": "BAD_REQUEST"}
    assert stack.call("ResolveDependencies", task_ids=[]) == {"error": "BAD_REQUEST"}
    ids = [f"p{n}" for n in range(12)]
    for task_id in ids:
        stack.tasks.add(task_id)
        stack.tasks.add("w" + task_id)
        stack.wait("w" + task_id, task_id)
        del stack.tasks.tasks[task_id]
    stack.reads()
    stack.d1.statements.clear()
    answer = stack.call("ResolveDependencies", task_ids=ids)
    assert stack.reads().count("GetTask") == 10
    assert len(answer["dropped_task_ids"]) == 10 and len(answer["dependencies"]) == 2
    # The settings read, the roles read and one batch of at most six.
    assert len(stack.d1.statements) <= 8


def test_a_reopened_task_linked_again_is_open_again(stack):
    stack.wait("invite", "venue")
    stack.complete("venue")
    stack.tasks.tasks["venue"]["completed"] = False  # reopened in Tasks
    stack.wait("budget", "venue")
    assert stack.closed()["venue"] is None
    assert [edge.get("done", False) for edge in stack.dependencies()] == [False, False]


def test_a_reopened_prerequisite_is_open_again_so_a_later_deletion_is_told(stack):
    """Review finding: a completion recorded in Plan outlived a reopening, so a later deletion was never told."""
    stack.wait("invite", "venue")
    stack.complete("venue")
    stack.tasks.tasks["venue"]["completed"] = False  # reopened in Tasks; Plan's read lists it, its dependency done
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue"}]}
    assert stack.closed()["venue"] is None
    del stack.tasks.tasks["venue"]
    assert stack.call("ResolveDependencies", task_ids=["venue"]) == {"dropped_task_ids": ["invite"]}
    assert stack.edges() == [] and stack.closed()["venue"] == "deleted"


def test_completing_succeeds_when_the_dependency_record_fails(stack, monkeypatch, capsys):
    """Review finding: Tasks has completed the task, so a failed D1 record must not report the completion failed."""
    stack.wait("invite", "venue")

    async def broken(*_args):
        raise RuntimeError("synthetic D1 failure")

    monkeypatch.setattr(stack.runtime.plus_api.plan_store, "close_tasks", broken)
    stack.reads()
    assert stack.complete("venue") == {"task_id": "venue"}
    assert "CompleteTask" in stack.reads() and stack.tasks.tasks["venue"]["completed"]
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1]) == {
        "plus": "completion_unrecorded",
        "error_type": "RuntimeError",
    }
    # Without the record, settling reads the task, as for one completed elsewhere in Tasks.
    answer = stack.call("ResolveDependencies", task_ids=["venue"])
    assert answer == {"dependencies": [{"task_id": "invite", "prerequisite_id": "venue", "done": True}]}
