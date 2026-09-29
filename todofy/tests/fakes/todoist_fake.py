"""Fake Todoist REST v1 tasks API, after sut/fakes/todoist.

``POST /api/v1/tasks`` creates a task with an auto-increment id; ``GET /api/v1/tasks``
lists active tasks (not completed, not deleted) of one project in pages of
``{"results", "next_cursor"}``. ``max_page_size`` caps every page whatever ``limit``
the client asks for, so tests can force paging with a handful of tasks.
"""

import itertools
import threading
from dataclasses import asdict, dataclass, field
from typing import Any

from tests.fakes.server import FakeServer, Recorded, Reply

TOKEN = "fake-todoist-token"
PROJECT_ID = "fake-project"
TASKS_PATH = "/api/v1/tasks"
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

    def json(self) -> dict[str, Any]:
        document = asdict(self)
        del document["request_id"]
        return document


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

    @property
    def tasks(self) -> list[Task]:
        with self._tasks_lock:
            return list(self._tasks)

    def add_task(self, content: str, description: str = "", project_id: str = PROJECT_ID, **flags: bool) -> Task:
        """Seed a task as if it had been created earlier (e.g. by hand, or by a lost call)."""
        with self._tasks_lock:
            task = Task(self._next_id(), content, description, project_id, **flags)
            self._tasks.append(task)
            return task

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

    def creates_for(self, event_id: str) -> list[Recorded]:
        return [r for r in self.creates() if event_id in r.json().get("description", "")]

    def lists(self) -> list[Recorded]:
        return self.received("GET", TASKS_PATH)

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
            task = Task(
                self._next_id(),
                fields["content"],
                fields.get("description", ""),
                fields.get("project_id") or PROJECT_ID,
                list(fields.get("labels", [])),
                request_id=request.headers.get("x-request-id"),
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
