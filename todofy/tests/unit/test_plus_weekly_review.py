"""ReadWeeklyReview through runtime/plus_api.handle on host CPython: the two facts of Plan's weekly review that
Todofy keeps (the newest review task it created, and the pending Mail entries), read with one D1 batch and no Tasks
call. D1 is host SQLite with every migration and Tasks a fake that journals every call (plus_support.py). Synthetic
data only.
"""

import asyncio
import json
import types
from collections.abc import Iterator
from typing import Any

import pytest

from tests.unit.plus_support import D1, NativeTasks, Storage, stubbed_pyodide

WEEK = "2026-10-12"  # ISO week 2026-W42; the previous one is 2026-W41


class Stack:
    def __init__(self, runtime: Any) -> None:
        self.runtime = runtime
        self.d1 = D1()
        self.tasks = NativeTasks("America/Los_Angeles")
        storage = Storage([])
        self.core = types.SimpleNamespace(
            env=types.SimpleNamespace(DB=self.d1, TASKS=self.tasks),
            plus_lock=asyncio.Lock(),
            sql=storage.sql,
            ctx=types.SimpleNamespace(storage=storage),
        )

    def call(self, method: str, **request: Any) -> dict[str, Any]:
        result = asyncio.run(self.runtime.plus_api.handle(self.core, method, json.dumps(request)))
        return {"error": result["error"]} if "error" in result else json.loads(result["ok"])

    def review(self, week: str, state: str, task_id: str) -> None:
        self.d1.db.execute(
            "INSERT INTO gtd_reviews (week, state, task_id, subject, body, created_at, updated_at)"
            " VALUES (?, ?, ?, 'Synthetic review', '', 1, 1)",
            (week, state, task_id),
        )
        self.d1.db.commit()

    def mail(self, event_id: str, *, triaged: bool = False) -> None:
        self.d1.db.execute(
            "INSERT INTO summaries (event_id, created_at, subject, summary, brief, model, triaged_at)"
            " VALUES (?, 1, 'Synthetic mail', 'Synthetic summary.', '', 'synthetic', ?)",
            (event_id, 2 if triaged else None),
        )
        self.d1.db.commit()


@pytest.fixture
def stack(monkeypatch: pytest.MonkeyPatch) -> Iterator[Stack]:
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import plus_api

        yield Stack(types.SimpleNamespace(plus_api=plus_api))


def test_the_newest_created_review_of_this_or_the_previous_week_and_the_pending_mail(stack):
    assert stack.call("ReadWeeklyReview", week_start=WEEK) == {}  # the wire profile omits empty values
    stack.review("2026-W40", "created", "synthetic-older-review")
    stack.review("2026-W41", "created", "synthetic-last-review")
    stack.mail("synthetic-pending-1")
    stack.mail("synthetic-pending-2")
    stack.mail("synthetic-triaged", triaged=True)
    assert stack.call("ReadWeeklyReview", week_start=WEEK) == {
        "review_task_id": "synthetic-last-review",
        "mailbox_pending_count": 2,
    }
    stack.review("2026-W42", "sending", "")
    assert stack.call("ReadWeeklyReview", week_start=WEEK)["review_task_id"] == "synthetic-last-review"
    stack.d1.db.execute(
        "UPDATE gtd_reviews SET state = 'created', task_id = 'synthetic-this-review' WHERE week = '2026-W42'"
    )
    stack.d1.db.commit()
    assert stack.call("ReadWeeklyReview", week_start=WEEK)["review_task_id"] == "synthetic-this-review"
    # Two weeks on, neither week has a review task.
    assert "review_task_id" not in stack.call("ReadWeeklyReview", week_start="2026-10-26")
    assert stack.tasks.calls == []


@pytest.mark.parametrize("week", ["", "2026-10-13", "2026-W42", "20261012"])
def test_the_week_is_a_monday(stack, week):
    assert stack.call("ReadWeeklyReview", week_start=week) == {"error": "BAD_REQUEST"}


def test_it_is_a_read_that_maintenance_does_not_hold(stack):
    stack.mail("synthetic-pending")
    stack.core.env.MAINTENANCE_MODE = "true"
    assert stack.call("ReadWeeklyReview", week_start=WEEK) == {"mailbox_pending_count": 1}
