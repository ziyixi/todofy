"""The private one-time cutover preserves native task content and planning choices."""

import json
import sqlite3
from pathlib import Path

import pytest

from tools.prepare_native_plan import prepare

ROOT = Path(__file__).parents[2]


def test_native_planning_import_moves_facts_and_keeps_content_history_and_plain_labels():
    planning = sqlite3.connect(":memory:")
    tasks = sqlite3.connect(":memory:")
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        planning.executescript(migration.read_text())
    for migration in sorted((ROOT.parent / "tasks/migrations").glob("*.sql")):
        tasks.executescript(migration.read_text())
    labels = [
        {"id": "stage", "title": "committed"},
        {"id": "lead", "title": "lead_1w"},
        {"id": "area", "title": "office"},
        {"id": "plain", "title": "Research"},
    ]
    for label in labels:
        tasks.execute(
            "INSERT INTO labels(id,title,created_at,updated_at) VALUES(?,?,1,1)", (label["id"], label["title"])
        )
    tasks.execute(
        "INSERT INTO filters(id,title,query,created_at,updated_at)"
        " VALUES('filter','Synthetic committed','@committed',1,1)"
    )
    tasks.execute(
        "INSERT INTO tasks(id,title,description,label_ids,due_date,deadline,recurrence,completed,created_at,updated_at)"
        " VALUES('parent','Synthetic','Keep full text',?,'2026-10-20','2026-10-30','every Tuesday',1,1,1)",
        (json.dumps(["stage", "lead", "area", "plain"]),),
    )
    data = {
        "now": 1792200000,
        "timezone": "UTC",
        "week_start": "2026-10-12",
        "labels": labels,
        "filters": [{"id": "filter", "query": "@committed"}],
        "mapping": {
            "labels": [
                {"role": "committed", "id": "stage", "label": "committed"},
                {"role": "office", "id": "area", "label": "office"},
                {"role": "lead_1w", "id": "lead", "label": "lead_1w"},
            ]
        },
        "tasks": [{"id": "parent", "label_ids": '["stage","lead","area","plain"]'}],
    }
    result = prepare(data)
    assert result["counts"] == {
        "planning_states": 1,
        "retired_labels": 3,
        "retired_filters": 1,
        "adopted_mail_tasks": 0,
    }
    planning.executescript(result["state_sql"])
    planning.executescript(result["state_sql"])
    assert planning.execute("SELECT stage,area,lead_days,rev FROM plan_task_state").fetchall() == [
        ("committed", "work", 7, 1)
    ]
    assert planning.execute("SELECT task_id,week_start,committed FROM plus_weeks").fetchall() == [
        ("parent", "2026-10-12", 1)
    ]
    tasks.executescript(result["retire_sql"])
    tasks.executescript(result["retire_sql"])
    assert tasks.execute(
        "SELECT description,label_ids,due_date,deadline,recurrence,completed FROM tasks"
    ).fetchone() == ("Keep full text", '["plain"]', "2026-10-20", "2026-10-30", "every Tuesday", 1)
    assert tasks.execute("SELECT label_id FROM task_labels").fetchall() == [("plain",)]
    assert tasks.execute("SELECT title FROM labels WHERE deleted_at IS NULL").fetchall() == [("Research",)]
    assert tasks.execute("SELECT count(*) FROM filters WHERE deleted_at IS NULL").fetchone() == (0,)
    planning.executescript(result["activate_sql"])
    assert planning.execute("SELECT timezone,week_start,enabled FROM plus_settings").fetchone() == (
        "UTC",
        "2026-10-12",
        1,
    )
    with pytest.raises(sqlite3.OperationalError):
        planning.executescript(result["state_sql"])


def test_native_planning_import_refuses_renamed_or_missing_label_identity():
    with pytest.raises(ValueError, match="PLANNING_LABEL_IDENTITY_CHANGED"):
        prepare(
            {
                "mapping": {"labels": [{"id": "a", "label": "Old", "role": "committed"}]},
                "labels": [{"id": "a", "title": "Changed"}],
            }
        )


def test_mailbox_adoption_keeps_only_current_legacy_inbox_and_does_not_reopen_filed_history():
    db = sqlite3.connect(":memory:")
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        db.executescript(migration.read_text())
    for event, task_id, imported, triaged in [
        ("pending", "old-pending", 0, None),
        ("filed", "old-filed", 0, None),
        ("already", "old-already", 0, 9),
        ("imported", "old-pending", 1, None),
        ("new-mail", "", 0, None),
    ]:
        db.execute(
            "INSERT INTO summaries(event_id,created_at,subject,summary,model,task_id,imported,triaged_at)"
            " VALUES(?,1,'Synthetic','Keep summary','synthetic',?,?,?)",
            (event, task_id, imported, triaged),
        )
    result = prepare(
        {
            "now": 5,
            "timezone": "UTC",
            "week_start": "2026-10-12",
            "mapping": {"labels": []},
            "labels": [],
            "filters": [],
            "tasks": [{"id": "old-pending", "label_ids": []}],
            "mailbox_task_ids": ["old-pending"],
        }
    )
    db.executescript(result["mailbox_sql"])
    rows = dict(db.execute("SELECT event_id,triaged_at FROM summaries"))
    assert rows == {"pending": None, "filed": 1, "already": 9, "imported": None, "new-mail": None}
    assert db.execute("SELECT count(*) FROM summaries WHERE summary='Keep summary'").fetchone() == (5,)
    db.executescript(result["activate_sql"])
    with pytest.raises(sqlite3.OperationalError):
        db.executescript(result["mailbox_sql"])
