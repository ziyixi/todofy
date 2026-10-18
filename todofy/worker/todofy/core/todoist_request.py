"""The frozen create-task request and the footer match of the lookup.

The module keeps its name: the request identity it freezes (``X-Request-Id``) is stored in the ledger's
``todoist_request_id`` column, and Tasks maps it to its own request ID (runtime/native_tasks.py). The size
limits follow todo/internal/todoist/client.go @ 6c46ed4, so a frozen request never changes size.
"""

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

MAX_POST_BODY_BYTES = 1 << 20
MAX_HEADER_BYTES = 65 << 10


class RequestTooLarge(ValueError):
    """Refused before sending."""


@dataclass(frozen=True, slots=True)
class TaskRequest:
    body: bytes
    headers: dict[str, str]


def build_task_request(
    content: str, description: str, project_id: str, request_id: str, *, parent_id: str = ""
) -> TaskRequest:
    """``parent_id`` makes a subtask (task-intent-v1): it is sent instead of ``project_id``, since a
    subtask always lives in its parent's project."""
    fields = {"content": content, "description": description}
    if parent_id:
        fields["parent_id"] = parent_id
    elif project_id:
        fields["project_id"] = project_id
    body = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()
    if len(body) > MAX_POST_BODY_BYTES:
        raise RequestTooLarge("body")
    headers = {"Content-Type": "application/json", "X-Request-Id": request_id}
    # Same estimate as the Go client: "Key: Value\r\n" per header plus the final CRLF.
    if 2 + sum(len(key) + len(value) + 4 for key, value in headers.items()) > MAX_HEADER_BYTES:
        raise RequestTooLarge("headers")
    return TaskRequest(body, headers)


def matching_task_ids(tasks: Iterable[dict[str, Any]], matches: Callable[[str], bool]) -> list[str]:
    """IDs of tasks whose description ``matches`` (a footer test)."""
    return [
        str(task.get("id", ""))
        for task in tasks
        if isinstance(task.get("description"), str) and matches(task["description"])
    ]
