"""Native task values projected into the existing planning rule input.

This is a local data conversion, not a Todoist API implementation. Existing planning rules keep their
tested semantics while the native store uses explicit field names and label IDs.
"""

from typing import Any


def metadata(catalog: dict[str, Any]) -> dict[str, Any]:
    return {
        "timezone": catalog["time_zone"],
        "labels": [{"id": row["id"], "name": row["title"]} for row in catalog.get("labels", [])],
        "filters": [
            {"id": row["id"], "name": row["title"], "query": row["query"]} for row in catalog.get("filters", [])
        ],
    }


def projects(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "id": row["id"],
            "name": row["title"],
            "parent_id": row.get("parent_id") or None,
            "is_archived": row.get("archived", False),
            "inbox_project": row.get("inbox", False),
            "color": row.get("color", ""),
        }
        for row in catalog.get("projects", [])
    ]


def task(row: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
    names = {label["id"]: label["title"] for label in catalog.get("labels", [])}
    inbox = next((project["id"] for project in catalog.get("projects", []) if project.get("inbox")), "")
    due = row.get("due_datetime") or row.get("due_date") or ""
    position = float(row.get("sort_order", 0))
    return {
        "id": row["id"],
        "content": row["title"],
        "description": row.get("description", row.get("description_preview", "")),
        "project_id": row.get("project_id") or inbox,
        "section_id": row.get("section_id") or None,
        "parent_id": row.get("parent_id") or None,
        "labels": [names[label] for label in row.get("label_ids", [])],
        "priority": 5 - row.get("priority", 4),
        "child_order": int(position) if position.is_integer() else None,
        "sort_order": row.get("sort_order", 0),
        "_native_etag": row["etag"],
        "due": {
            "date": due,
            "is_recurring": bool(row.get("recurrence")),
            "string": row.get("recurrence", ""),
            "timezone": row.get("due_timezone") or None,
        }
        if due
        else None,
        "deadline": {"date": row["deadline"]} if row.get("deadline") else None,
        "duration": {"amount": row["duration_minutes"], "unit": "minute"} if row.get("duration_minutes") else None,
        "checked": row.get("completed", False),
        "completed_at": row.get("complete_time"),
        "is_archived": row.get("archived", False),
        "archived": row.get("archived", False),
        "completed_count": row.get("completed_count", 0),
        "added_at": row.get("create_time"),
        "updated_at": row.get("update_time"),
    }
