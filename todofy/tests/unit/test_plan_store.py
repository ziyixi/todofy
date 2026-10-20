"""The planning store (migrations/0007_plan_store.sql) on host SQLite, synthetic rows only: its CHECKs and the
partial Mailbox index. Mail's categories are the store's rows that still change; Tasks owns planning."""

import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
PLAN_MIGRATION = Path(__file__).parents[2] / "migrations" / "0007_plan_store.sql"
NOW = 1_760_000_000


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    for migration in MIGRATIONS:
        connection.executescript(migration.read_text())
    yield connection
    connection.close()


def add_task(db: sqlite3.Connection, external_id: str, provider: str = "todoist") -> int:
    cursor = db.execute(
        "INSERT INTO plan_tasks (provider, external_id, created_at) VALUES (?, ?, ?)", (provider, external_id, NOW)
    )
    return int(cursor.lastrowid)


def rejected(db: sqlite3.Connection, statement: str, args: tuple = ()) -> bool:
    try:
        db.execute(statement, args)
    except sqlite3.IntegrityError:
        return True
    return False


def test_glob_patterns_stay_under_d1s_50_byte_limit():
    patterns = re.findall(r"GLOB '([^']*)'", PLAN_MIGRATION.read_text())
    assert patterns and all(len(pattern.encode()) < 50 for pattern in patterns)


@pytest.mark.parametrize(
    "statement",
    [
        pytest.param("INSERT INTO plan_marks VALUES (1, 'kept', '2026-W42', 0)", id="iso_week_is_not_a_period"),
        pytest.param("INSERT INTO plan_marks VALUES (1, 'Bet', '2026-10-19', 0)", id="kind_is_lower_case"),
        pytest.param(
            "INSERT INTO plan_tasks (provider, external_id, created_at) VALUES ('todoist', 'a b', 0)",
            id="external_id_charset",
        ),
        pytest.param(
            "INSERT INTO plan_tasks (provider, external_id, created_at, closed_at) VALUES ('todoist', 'a', 0, 1)",
            id="closed_at_without_closed_as",
        ),
        pytest.param(
            "INSERT INTO plan_notes (period, area, kind, body, updated_at) VALUES ('2026-10-12', '', 'review', 'x', 0)",
            id="review_progress_is_json",
        ),
        pytest.param("INSERT INTO plan_edges (task_id, prerequisite_id, created_at) VALUES (1, 1, 0)", id="self_edge"),
        pytest.param("INSERT INTO plan_settings VALUES ('Week', '{}', 0)", id="setting_key_shape"),
        pytest.param("INSERT INTO plan_settings VALUES ('week', 'not json', 0)", id="setting_is_json"),
        pytest.param(
            "INSERT INTO plan_categories (name, priority, created_at, updated_at) VALUES ('Reply', 5, 0, 0)",
            id="priority_range",
        ),
    ],
)
def test_checks_refuse_malformed_rows(db, statement):
    assert rejected(db, statement)


def test_an_active_category_name_is_unique_and_an_archived_one_may_return(db):
    insert = "INSERT INTO plan_categories (name, priority, created_at, updated_at) VALUES ('Reply', 2, 0, 0)"
    db.execute(insert)
    assert rejected(db, insert)
    db.execute("UPDATE plan_categories SET archived_at = 1")
    db.execute(insert)
    assert db.execute("SELECT count(*) FROM plan_categories").fetchone() == (2,)


def test_task_ids_are_never_reused(db):
    first = add_task(db, "A")
    db.execute("DELETE FROM plan_tasks WHERE id = ?", (first,))
    assert add_task(db, "B") > first


def test_triage_columns_are_additive(db):
    db.execute(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model) VALUES ('e1', 1, 's', 'One. Two.', 'm')"
    )
    assert db.execute("SELECT category_id, triaged_at FROM summaries").fetchall() == [(None, None)]
    assert rejected(db, "UPDATE summaries SET category_id = 0")


def test_the_mailbox_index_holds_only_delivered_mail_tasks(db):
    rows = [(f"legacy:{n}", 1, "s", "x", "m", f"old{n}", 1) for n in range(5)]
    rows += [(f"e{n}", 2, "s", "x", "m", f"t{n}" if n else "", 0) for n in range(4)]
    db.executemany(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id, imported)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    lookup = (
        "SELECT event_id FROM summaries WHERE task_id IN (SELECT value FROM json_each(?))"
        " AND task_id <> '' AND imported = 0"
    )
    plan_steps = " | ".join(row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {lookup}", ('["t1"]',)))
    assert "USING INDEX summaries_task" in plan_steps and "SCAN summaries" not in plan_steps, plan_steps
    assert db.execute(lookup, ('["t1","t3","old1"]',)).fetchall() == [("e1",), ("e3",)]
    indexed = "SELECT count(*) FROM summaries INDEXED BY summaries_task WHERE task_id <> '' AND imported = 0"
    assert db.execute(indexed).fetchone() == (3,)
