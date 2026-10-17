from todofy.core import native_task_view as view

CATALOG = {
    "time_zone": "America/Los_Angeles",
    "labels": [{"id": "l1", "title": "committed"}],
    "projects": [{"id": "original-inbox", "title": "Inbox", "inbox": True}],
    "filters": [],
}


def test_native_projection_preserves_planning_identity_and_due_deadline_distinction():
    result = view.task(
        {
            "id": "old-task",
            "etag": "2",
            "title": "Synthetic task",
            "priority": 1,
            "label_ids": ["l1"],
            "due_date": "2026-10-20",
            "deadline": "2026-10-24",
            "recurrence": "every Tue",
            "completed_count": 12,
        },
        CATALOG,
    )
    assert result["id"] == "old-task"
    assert result["project_id"] == "original-inbox"
    assert result["labels"] == ["committed"]
    assert result["priority"] == 4
    assert result["due"]["date"] == "2026-10-20"
    assert result["deadline"]["date"] == "2026-10-24"
    assert result["completed_count"] == 12


def test_native_metadata_uses_imported_timezone_and_label_ids():
    assert view.metadata(CATALOG)["timezone"] == "America/Los_Angeles"
    assert view.metadata(CATALOG)["labels"] == [{"id": "l1", "name": "committed"}]
    assert view.projects(CATALOG)[0]["inbox_project"] is True
