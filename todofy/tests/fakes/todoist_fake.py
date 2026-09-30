"""Fake Todoist REST v1 tasks API, after sut/fakes/todoist.

``POST /api/v1/tasks`` creates a task with an auto-increment id; ``GET /api/v1/tasks``
lists active tasks (not completed, not deleted) of one project, or of every project
without ``project_id``, in pages of ``{"results", "next_cursor"}``;
``GET /api/v1/tasks/completed/by_completion_date`` lists completed tasks with
``completed_at`` in ``[since, until)`` in pages of ``{"items", "next_cursor"}``, with
``next_cursor`` left out on the last page, as Todoist does. A create with ``parent_id`` makes a
subtask in its parent's project (an unknown parent is a 400, as upstream). ``max_page_size`` caps
every page whatever ``limit`` the client asks for, so tests can force paging with a handful of
tasks. Task text is synthetic: tests seed sentinels and check they never leave the Worker.
"""

import itertools
import threading
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from tests.fakes.server import FakeServer, Recorded, Reply

TOKEN = "fake-todoist-token"
PROJECT_ID = "fake-project"
TASKS_PATH = "/api/v1/tasks"
COMPLETED_PATH = "/api/v1/tasks/completed/by_completion_date"
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
_CURSOR_PREFIX = "fake-cursor-"


@dataclass
class Task:
    id: str
    content: str
    description: str = ""
    project_id: str = PROJECT_ID
    labels: list[str] = field(default_factory=list)
    checked: bool = False
    is_deleted: bool = False
    request_id: str | None = None
    priority: int = 1
    due: dict[str, Any] | None = None
    deadline: dict[str, Any] | None = None
    parent_id: str | None = None
    added_at: str | None = None
    completed_at: str | None = None

    def json(self) -> dict[str, Any]:
        document = asdict(self)
        del document["request_id"]
        return document


def stamp(seconds: float) -> str:
    """Todoist's timestamp form (UTC, microseconds, ``Z``)."""
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _seconds(value: str | None) -> float | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class TodoistFake(FakeServer):
    def __init__(self, token: str = TOKEN, max_page_size: int = MAX_LIMIT) -> None:
        super().__init__()
        self.token = token
        self.max_page_size = max_page_size
        self._tasks_lock = threading.Lock()
        self._tasks: list[Task] = []
        self._ids = itertools.count(1)
        self.route("POST", TASKS_PATH, self._create)
        self.route("GET", TASKS_PATH, self._list)
        self.route("GET", COMPLETED_PATH, self._completed)

    @property
    def tasks(self) -> list[Task]:
        with self._tasks_lock:
            return list(self._tasks)

    def add_task(self, content: str, description: str = "", project_id: str = PROJECT_ID, **fields: Any) -> Task:
        """Seed a task as if it had been created earlier (e.g. by hand, or by a lost call); ``fields``
        sets any other Task field (labels, priority, due, added_at, ...)."""
        with self._tasks_lock:
            task = Task(self._next_id(), content, description, project_id, **fields)
            self._tasks.append(task)
            return task

    def complete(self, task_id: str, at: float) -> None:
        """Mark a task completed at Unix time ``at`` (it leaves the active list)."""
        with self._tasks_lock:
            for task in self._tasks:
                if task.id == task_id:
                    task.checked, task.completed_at = True, stamp(at)

    def delete(self, task_id: str) -> None:
        with self._tasks_lock:
            for task in self._tasks:
                if task.id == task_id:
                    task.is_deleted = True

    def seed(self, document: Any) -> None:
        for task in document.get("tasks", []):
            self.add_task(**task)

    def reset_state(self) -> None:
        with self._tasks_lock:
            self._tasks.clear()
        self.max_page_size = MAX_LIMIT

    def state(self) -> dict[str, Any]:
        return super().state() | {"tasks": [task.json() for task in self.tasks]}

    def creates(self) -> list[Recorded]:
        """Every POST /api/v1/tasks the Worker sent, including rejected ones."""
        return self.received("POST", TASKS_PATH)

    def request_ids(self) -> list[str | None]:
        """X-Request-Id of every POST /api/v1/tasks, in order."""
        return [r.headers.get("x-request-id") for r in self.creates()]

    def creates_for(self, event_id: str) -> list[Recorded]:
        return [r for r in self.creates() if event_id in r.json().get("description", "")]

    def lists(self) -> list[Recorded]:
        return self.received("GET", TASKS_PATH)

    def completed_lists(self) -> list[Recorded]:
        return self.received("GET", COMPLETED_PATH)

    def authorize(self, request: Recorded) -> Reply | None:
        if request.path.startswith("/api/") and request.headers.get("authorization") != f"Bearer {self.token}":
            return Reply(401, {"error": "Unauthorized"})
        return None

    def _next_id(self) -> str:
        return f"6Xfake{next(self._ids):06d}"

    def _create(self, request: Recorded, _: Any) -> Reply:
        try:
            fields = request.json()
        except ValueError:
            return Reply(400, {"error": "invalid json"})
        if not isinstance(fields, dict) or not isinstance(fields.get("content"), str) or not fields["content"].strip():
            return Reply(400, {"error": "content is required"})
        with self._tasks_lock:
            project = fields.get("project_id") or PROJECT_ID
            parent_id = fields.get("parent_id")
            if parent_id is not None:
                parent = next((task for task in self._tasks if task.id == parent_id), None)
                if parent is None:
                    return Reply(400, {"error": "parent not found"})
                project = parent.project_id
            task = Task(
                self._next_id(),
                fields["content"],
                fields.get("description", ""),
                project,
                list(fields.get("labels", [])),
                request_id=request.headers.get("x-request-id"),
                added_at=stamp(request.at),
                parent_id=parent_id,
            )
            self._tasks.append(task)
        return Reply(200, task.json())

    def _list(self, request: Recorded, _: Any) -> Reply:
        project = request.param("project_id")
        try:
            limit = min(max(int(request.param("limit") or DEFAULT_LIMIT), 1), MAX_LIMIT, self.max_page_size)
            offset = int((request.param("cursor") or f"{_CURSOR_PREFIX}0").removeprefix(_CURSOR_PREFIX))
        except ValueError:
            return Reply(400, {"error": "invalid limit or cursor"})
        active = [
            task
            for task in self.tasks
            if not task.checked and not task.is_deleted and (project is None or task.project_id == project)
        ]
        page = active[offset : offset + limit]
        more = offset + limit < len(active)
        return Reply(
            200,
            {
                "results": [task.json() for task in page],
                "next_cursor": f"{_CURSOR_PREFIX}{offset + limit}" if more else None,
            },
        )

    def _completed(self, request: Recorded, _: Any) -> Reply:
        try:
            since, until = _seconds(request.param("since")), _seconds(request.param("until"))
            limit = min(max(int(request.param("limit") or DEFAULT_LIMIT), 1), MAX_LIMIT, self.max_page_size)
            offset = int((request.param("cursor") or f"{_CURSOR_PREFIX}0").removeprefix(_CURSOR_PREFIX))
        except ValueError:
            return Reply(400, {"error": "invalid since, until, limit or cursor"})
        if since is None or until is None or until - since > 92 * 86400:
            return Reply(400, {"error": "since and until are required, at most 3 months apart"})
        done = [
            task
            for task in self.tasks
            if task.checked
            and not task.is_deleted
            and (at := _seconds(task.completed_at)) is not None
            and since <= at < until
            and (request.param("project_id") is None or task.project_id == request.param("project_id"))
        ]
        done.sort(key=lambda task: task.completed_at or "", reverse=True)
        page = {"items": [task.json() for task in done[offset : offset + limit]]}
        if offset + limit < len(done):
            page["next_cursor"] = f"{_CURSOR_PREFIX}{offset + limit}"
        return Reply(200, page)
