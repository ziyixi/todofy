"""The planning store (migrations/0007_plan_store.sql) on host SQLite, synthetic rows only: its CHECKs, the
partial Mailbox index, the owner's VerifyPlanStore counts and the Review lanes' order (core/sql/plan.py)."""

import json
import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from todofy.core import plan
from todofy.core.sql import plan as sql

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
PLAN_MIGRATION = Path(__file__).parents[2] / "migrations" / "0007_plan_store.sql"
NOW = 1_760_000_000
WEEK = "2026-10-12"
PLAN_TABLES = {
    "plan_settings",
    "plan_tasks",
    "plan_marks",
    "plan_edges",
    "plan_notes",
    "plan_categories",
    "plan_task_state",
}


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    for migration in MIGRATIONS:
        connection.executescript(migration.read_text())
    yield connection
    connection.close()


def counts(db: sqlite3.Connection) -> dict[str, int]:
    row = db.execute(sql.VERIFY).fetchone()
    return dict(zip(sql.VERIFY_COUNTS, row, strict=True))


def anomalies(db: sqlite3.Connection) -> dict[str, int]:
    return {name: value for name, value in counts(db).items() if not name.endswith("_row_count") and value}


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


def test_verify_reads_only_the_plan_tables(db):
    steps = [row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {sql.VERIFY}")]
    tables = {match for step in steps for match in re.findall(r"^(?:SCAN|SEARCH) (\w+)", step)}
    assert tables and tables <= PLAN_TABLES | {"CONSTANT"}, steps


def test_verify_of_an_empty_store_is_all_zero(db):
    assert counts(db) == dict.fromkeys(sql.VERIFY_COUNTS, 0)


def test_verify_counts_native_state_and_missing_or_wrong_provider_identity(db):
    native = add_task(db, "native", provider="tasks")
    legacy = add_task(db, "legacy")
    db.executemany(
        "INSERT INTO plan_task_state(task_id,request_id,updated_at) VALUES (?,'synthetic',1)",
        [(native,), (legacy,), (99,)],
    )
    result = counts(db)
    assert result["state_row_count"] == 3
    assert result["orphan_state_count"] == 2


def test_verify_counts_rows_and_every_broken_rule(db):
    db.execute("""INSERT INTO plan_settings VALUES ('week', '{"current": "2026-10-12"}', 1)""")
    a, b = add_task(db, "A"), add_task(db, "B")
    db.execute("INSERT INTO plan_marks VALUES (?, 'committed', ?, 1)", (a, WEEK))
    db.execute("INSERT INTO plan_edges (task_id, prerequisite_id, created_at) VALUES (?, ?, 1)", (a, b))
    db.execute(
        "INSERT INTO plan_notes (period, area, kind, body, updated_at) VALUES (?, 'work', 'bets', 'Ship', 1)", (WEEK,)
    )
    db.execute("INSERT INTO plan_categories (name, created_at, updated_at) VALUES ('Reply', 1, 1)")
    assert counts(db) == {
        **dict.fromkeys(sql.VERIFY_COUNTS, 0),
        "settings_row_count": 1,
        "task_row_count": 2,
        "mark_row_count": 1,
        "edge_row_count": 1,
        "note_row_count": 1,
        "category_row_count": 1,
    }
    # A restore that lost a task identity, values a newer build wrote, and limits a bug ignored.
    db.execute("INSERT INTO plan_marks VALUES (99, 'kept', ?, 1)", (WEEK,))
    db.execute("INSERT INTO plan_edges (task_id, prerequisite_id, created_at) VALUES (?, 98, 1)", (b,))
    db.execute("INSERT INTO plan_settings VALUES ('later', '{}', 1), ('account', '[]', 1)")
    add_task(db, "C", provider="linear")
    db.execute("INSERT INTO plan_marks VALUES (?, 'snoozed', ?, 1)", (a, WEEK))
    db.execute("INSERT INTO plan_categories (scheme, name, created_at, updated_at) VALUES ('area', 'Home', 1, 1)")
    for n in range(plan.MAX_EDGES_PER_TASK + 1):
        db.execute("INSERT INTO plan_edges (task_id, prerequisite_id, created_at) VALUES (?, ?, 1)", (a, 1000 + n))
    for n in range(plan.MAX_ACTIVE_CATEGORIES):
        db.execute("INSERT INTO plan_categories (name, created_at, updated_at) VALUES (?, 1, 1)", (f"c{n}",))
    assert anomalies(db) == {
        "orphan_mark_count": 1,
        "orphan_edge_count": 1 + plan.MAX_EDGES_PER_TASK + 1,  # b -> 98 and every a -> 1000+n
        "unknown_value_count": 5,  # 'later', a non-object 'account', 'linear', 'snoozed', scheme 'area'
        "limit_violation_count": 2,  # task a's dependencies and the mail scheme's active categories
    }
    db.executemany(
        "INSERT INTO plan_edges (task_id, prerequisite_id, created_at) VALUES (?, ?, 1)",
        [(2000 + n, a) for n in range(plan.MAX_EDGES)],
    )
    assert counts(db)["limit_violation_count"] == 3  # and the total


# ---- dependencies (core/sql/plan.py; the runtime path is test_plus_dependencies.py) ----------------------------


def test_closed_as_is_the_vocabulary_of_core_plan(db):
    columns = db.execute("SELECT sql FROM sqlite_master WHERE name = 'plan_tasks'").fetchone()[0]
    assert re.findall(r"'(\w+)'", re.search(r"closed_as IN \(([^)]*)\)", columns).group(1)) == [
        plan.COMPLETED,
        plan.DELETED,
    ]


def test_every_dependency_is_one_scan_of_the_edges_and_rowid_lookups(db):
    steps = [row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {sql.EDGES}")]
    assert steps == [
        "SCAN e",
        "SEARCH w USING INTEGER PRIMARY KEY (rowid=?)",
        "SEARCH p USING INTEGER PRIMARY KEY (rowid=?)",
    ]


def test_dependency_statements_keep_the_store_consistent(db):
    def run(query, *args):
        return db.execute(query.sql, args).fetchall()

    run(sql.ADD_TASKS, "todoist", NOW, '["A", "B", "C"]')
    run(sql.ADD_EDGE, 9, NOW, "todoist", "A", "todoist", "B")
    run(sql.ADD_EDGE, 2, NOW, "todoist", "A", "todoist", "B")  # an existing (done) edge starts over, in its row
    run(sql.ADD_EDGE, 0, NOW + 1, "todoist", "C", "todoist", "B")
    run(sql.ADD_EDGE, 0, NOW, "todoist", "A", "todoist", "missing")  # no identity, no edge
    assert db.execute(sql.EDGES).fetchall() == [("A", "B", 2, 0), ("C", "B", 0, 0)]
    assert run(sql.TASK_EDGES, "todoist", "A") == [("A", "B", 2, 0)]
    assert run(sql.WAITERS, "todoist", '["B"]') == [("A",), ("C",)]
    run(sql.CLOSE_TASKS, NOW, plan.COMPLETED, "todoist", '["B"]')
    run(sql.CLOSE_TASKS, NOW, plan.DELETED, "todoist", '["B"]')  # the first answer stays
    assert [row[3] for row in db.execute(sql.EDGES)] == [1, 1]
    # Registering a task the store confirmed active opens it again.
    run(sql.ADD_TASKS, "todoist", NOW, '["B"]')
    assert db.execute("SELECT closed_at, closed_as FROM plan_tasks WHERE external_id = 'B'").fetchone() == (None, None)
    run(sql.FORGET_WAITS, "todoist", '["C"]')
    assert db.execute(sql.EDGES).fetchall() == [("A", "B", 2, 0)]
    run(sql.REMOVE_EDGE, "todoist", "A", "todoist", "B")
    run(sql.ADD_EDGE, 0, NOW, "todoist", "C", "todoist", "A")
    run(sql.FORGET_PREREQUISITES, "todoist", '["A"]')
    assert db.execute(sql.EDGES).fetchall() == [] and anomalies(db) == {}
    assert counts(db)["task_row_count"] == 3  # identities are never deleted


# ---- the Review lanes' order (plan_settings 'board'; the runtime path is tests/runtime/test_plus.py) ------------


def test_the_board_is_a_known_setting(db):
    db.execute("""INSERT INTO plan_settings VALUES ('board', '{"lanes": {"weekly": [1]}}', 1)""")
    assert anomalies(db) == {}


def test_every_lane_order_is_one_key_search_two_json_scans_and_rowid_lookups(db):
    steps = [row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {sql.LANE_ORDERS}")]
    assert len(steps) == 4, steps
    for step, prefix in zip(
        steps,
        (
            "SEARCH s USING INDEX sqlite_autoindex_plan_settings_1",
            "SCAN l VIRTUAL TABLE",
            "SCAN k VIRTUAL TABLE",
            "SEARCH t USING INTEGER PRIMARY KEY (rowid=?)",
        ),
        strict=True,
    ):
        assert step.startswith(prefix), steps


def test_arranging_a_lane_takes_its_tasks_from_every_other_lane():
    board = {"lanes": {"weekly": [1, 2, 3], "monthly": [4, 2], "waiting": [5]}}
    assert plan.arrange_lane(board, "committed", [3, 2, 3]) == {
        "lanes": {"weekly": [1], "monthly": [4], "waiting": [5], "committed": [3, 2]}
    }
    # A lane left empty leaves the document, an empty order removes its own lane, and the order is capped.
    assert plan.arrange_lane(board, "start", [5])["lanes"].keys() == {"weekly", "monthly", "start"}
    assert plan.arrange_lane(board, "weekly", []) == {"lanes": {"monthly": [4, 2], "waiting": [5]}}
    many = list(range(1, plan.MAX_LANE_TASKS + 20))
    assert plan.arrange_lane({}, "parked", many) == {"lanes": {"parked": many[: plan.MAX_LANE_TASKS]}}


def test_lane_orders_follow_the_board_and_skip_what_this_build_does_not_know(db):
    ids = {name: add_task(db, name) for name in ("A", "B", "C", "D")}
    board = {"lanes": {"committed": [ids["C"], ids["A"]], "start": [ids["B"]], "later": [ids["D"]]}}
    db.execute("INSERT INTO plan_settings VALUES ('board', ?, 1)", (json.dumps(board),))
    rows = [(lane, int(position), task) for lane, position, task in db.execute(sql.LANE_ORDERS)]
    assert plan.lane_orders(rows) == [
        {"lane": "start", "task_ids": ["B"]},
        {"lane": "committed", "task_ids": ["C", "A"]},
    ]
    assert plan.lane_orders([("weekly", plan.MAX_LANE_TASKS, "X"), ("weekly", 1, "B"), ("weekly", 0, "A")]) == [
        {"lane": "weekly", "task_ids": ["A", "B"]}
    ]
    assert plan.lane_orders([]) == []
