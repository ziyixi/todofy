"""Todoist REST v1 wire format: the frozen create-task request and task-list pages.

Size limits and the page envelope follow todo/internal/todoist/client.go @ 6c46ed4.
Tasks carry no labels (the dependency DAG is gone).
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .render import has_footer

TASKS_PATH = "/api/v1/tasks"
MAX_POST_BODY_BYTES = 1 << 20
MAX_HEADER_BYTES = 65 << 10


class RequestTooLarge(ValueError):
    """Refused before sending: Todoist would reject it anyway."""


@dataclass(frozen=True, slots=True)
class TaskRequest:
    body: bytes
    headers: dict[str, str]


def build_task_request(content: str, description: str, project_id: str, request_id: str, token: str) -> TaskRequest:
    fields = {"content": content, "description": description}
    if project_id:
        fields["project_id"] = project_id
    body = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()
    if len(body) > MAX_POST_BODY_BYTES:
        raise RequestTooLarge("body")
    headers = {
        "Authorization": f"Bearer {token.strip()}",
        "Content-Type": "application/json",
        "X-Request-Id": request_id,
    }
    # Same estimate as the Go client: "Key: Value\r\n" per header plus the final CRLF.
    if 2 + sum(len(key) + len(value) + 4 for key, value in headers.items()) > MAX_HEADER_BYTES:
        raise RequestTooLarge("headers")
    return TaskRequest(body, headers)


def created_task_id(body: bytes) -> str:
    """The ``id`` of a create-task response, or ``""`` when it has none."""
    try:
        task = json.loads(body)
    except ValueError:
        return ""
    task_id = task.get("id") if isinstance(task, dict) else None
    return task_id if isinstance(task_id, str) else ""


def parse_task_page(body: bytes) -> tuple[list[dict[str, Any]], str]:
    """Tasks and next cursor (``""`` on the last page) of a task-list response.

    Accepts the ``{"results", "next_cursor"}`` envelope and the older bare array.
    Raises ValueError for anything else.
    """
    page = json.loads(body) if body.strip() else []
    if isinstance(page, list):
        tasks, cursor = page, ""
    elif isinstance(page, dict) and isinstance(page.get("results"), list):
        tasks, cursor = page["results"], page.get("next_cursor") or ""
    else:
        raise ValueError("unexpected task page")
    if not isinstance(cursor, str) or not all(isinstance(task, dict) for task in tasks):
        raise ValueError("unexpected task page")
    return tasks, cursor


def footer_task_ids(tasks: Iterable[dict[str, Any]], event_id: str) -> list[str]:
    """IDs of tasks whose description carries the event's footer."""
    return [
        str(task.get("id", ""))
        for task in tasks
        if isinstance(task.get("description"), str) and has_footer(task["description"], event_id)
    ]
