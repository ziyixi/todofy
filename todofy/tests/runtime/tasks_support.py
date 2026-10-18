"""What runtime tests read and write in the real Tasks Worker's D1 (harness.py starts it next to the core).

Seeded rows go straight into Tasks' tables, so a test controls their creation times; everything the core
writes goes through TasksApi. Synthetic tasks only.
"""

import json
import uuid
from typing import Any

from tests.runtime.harness import Worker

DAY = 86_400


def text(value: Any) -> str:
    """A SQL literal (synthetic values only)."""
    return "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"


def seed(worker: Worker, *rows: dict[str, Any], now: int) -> list[str]:
    """Tasks in Tasks' D1, one per row: ``id``, ``title``, ``description``, ``project``, ``added`` (Unix seconds;
    else 400 days before ``now``), ``labels`` (titles), ``due_date``, ``due_datetime``, ``due_timezone``,
    ``deadline`` and ``recurrence``, with the projects and labels they name. Their IDs."""
    statements, ids = [], []
    for row in rows:
        task_id = row.get("id") or "t" + uuid.uuid4().hex[:12]
        project, labels = row.get("project", ""), list(row.get("labels", ()))
        if project:
            statements.append(
                "INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)"
                f" VALUES ({text(project)}, 'p', 1, 1)"
            )
        for label in labels:
            statements.append(
                "INSERT OR IGNORE INTO labels (id, title, created_at, updated_at)"
                f" VALUES ({text('l-' + label)}, {text(label)}, 1, 1)"
            )
        created = (row.get("added") or now - 400 * DAY) * 1000
        values = [
            text(task_id),
            text(row.get("title", "Synthetic task")),
            text(row.get("description", "")),
            text(project),
            text(json.dumps(["l-" + label for label in labels])),
            text(row.get("due_date", "")),
            text(row.get("due_datetime", "")),
            text(row.get("due_timezone", "")),
            text(row.get("deadline", "")),
            text(row.get("recurrence", "")),
            str(created),
            str(created),
        ]
        statements.append(
            "INSERT INTO tasks (id, title, description, project_id, label_ids, due_date, due_datetime, due_timezone,"
            f" deadline, recurrence, created_at, updated_at) VALUES ({', '.join(values)})"
        )
        ids.append(task_id)
    worker.tasks_d1(";".join(statements))
    return ids


def complete(worker: Worker, task_id: str, at: int) -> None:
    """Completed in Tasks at ``at`` (Unix seconds): the task closes and its completion is recorded."""
    worker.tasks_d1(
        f"UPDATE tasks SET completed = 1, completed_at = {at * 1000} WHERE id = {text(task_id)};"
        "INSERT INTO completions (id, task_id, title, completed_at, project_id, task_created_at)"
        f" SELECT 'c-' || id, id, title, {at * 1000}, project_id, created_at FROM tasks WHERE id = {text(task_id)}"
    )


def project(worker: Worker, project_id: str) -> None:
    """A Tasks project with a fixed ID, as an imported account has."""
    worker.tasks_d1(
        f"INSERT INTO projects (id, title, created_at, updated_at) VALUES ({text(project_id)}, 'Synthetic', 1, 1)"
    )


def created(worker: Worker) -> list[dict[str, Any]]:
    """The tasks Tasks holds, oldest first."""
    return worker.tasks_d1(
        "SELECT id, title, description, project_id, parent_id, completed FROM tasks WHERE deleted_at IS NULL"
        " ORDER BY created_at, rowid"
    )


def request_ids(worker: Worker) -> list[str]:
    """The request IDs Tasks ran (a refused write leaves none)."""
    return [row["id"] for row in worker.tasks_d1("SELECT id FROM requests ORDER BY created_at, rowid")]
