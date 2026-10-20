from todofy.core import native_task_view as view

CATALOG = {
    "time_zone": "America/Los_Angeles",
    "labels": [{"id": "l1", "title": "committed"}],
    "projects": [{"id": "original-inbox", "title": "Inbox", "inbox": True}],
    "filters": [],
}


def test_native_projection_preserves_identity_and_due_deadline_distinction():
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


def test_evening_timed_task_keeps_local_day_and_exact_overdue_instant():
    from datetime import UTC, datetime

    from todofy.core import gtd

    projected = view.task(
        {
            "id": "evening-step",
            "etag": "3",
            "title": "Synthetic evening step",
            "due_date": "2026-10-20",
            "due_datetime": "2026-10-21T04:00:00Z",
            "due_timezone": "America/Los_Angeles",
        },
        CATALOG,
    )
    assert projected["due"]["date"] == "2026-10-20"
    assert projected["due"]["datetime"] == "2026-10-21T04:00:00Z"
    snapshot = gtd.snapshot_row(projected, bytes(32))
    due_at = int(datetime(2026, 10, 21, 4, tzinfo=UTC).timestamp())
    assert snapshot["due_at"] == due_at
    assert not gtd.is_overdue(snapshot, due_at - 1, "2026-10-21")
    assert gtd.is_overdue(snapshot, due_at + 1, "2026-10-21")
