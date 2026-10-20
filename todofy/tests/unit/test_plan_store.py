"""What is left of the planning store (migrations/0007_plan_store.sql) on host SQLite, synthetic rows only: the Mail
categories' CHECKs, the partial Mailbox index, and 0013, which dropped the rest once Tasks owned planning."""

import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
PLAN_MIGRATION = Path(__file__).parents[2] / "migrations" / "0007_plan_store.sql"
DROP_MIGRATION = Path(__file__).parents[2] / "migrations" / "0013_drop_plan_store.sql"


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    for migration in MIGRATIONS:
        connection.executescript(migration.read_text())
    yield connection
    connection.close()


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
        pytest.param("INSERT INTO plan_settings VALUES ('Todoist.mail', '{}', 0)", id="setting_key_shape"),
        pytest.param("INSERT INTO plan_settings VALUES ('todoist.mail', 'not json', 0)", id="setting_is_json"),
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


def test_the_drop_keeps_only_the_mail_categories():
    """0013 drops the planning store Tasks copied; Mail's categories and their 'todoist.mail' binding stay."""
    db = sqlite3.connect(":memory:")
    for migration in MIGRATIONS[: MIGRATIONS.index(DROP_MIGRATION)]:
        db.executescript(migration.read_text())
    db.executemany("INSERT INTO plan_settings VALUES (?, '{}', 0)", [("week",), ("board",), ("todoist.mail",)])
    db.execute("INSERT INTO plan_categories (name, priority, created_at, updated_at) VALUES ('Reply', 2, 0, 0)")
    db.execute("INSERT INTO plan_tasks (provider, external_id, created_at) VALUES ('todoist', 'A', 0)")
    db.executescript(DROP_MIGRATION.read_text())
    assert db.execute("SELECT key FROM plan_settings").fetchall() == [("todoist.mail",)]
    assert db.execute("SELECT name, priority FROM plan_categories").fetchall() == [("Reply", 2)]
    assert db.execute("SELECT count(*) FROM sqlite_master WHERE name = 'plan_tasks'").fetchone() == (0,)
    db.close()


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
