"""migrations/*.sql on host SQLite (D1 is SQLite): shape, vocabulary and query plans.

Every ``Query`` constant under todofy/core/sql is found automatically and must
use the index it names, so runtime SQL cannot drift from what is tested here.
"""

import importlib
import pkgutil
import re
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

import todofy.core.sql as sql_package
from todofy.core.report_schema import ReportStatus
from todofy.core.sql import ACTIVE_STATES, Query, views
from todofy.core.sql import metrics as metrics_sql
from todofy.core.sql import reminders as reminder_sql
from todofy.core.vocab import TERMINAL_STATES, EventState, ReminderState

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
SOURCE = "mail-hero-personal"
HASH = "0" * 64


def discover_queries() -> dict[str, Query]:
    queries = {}
    for module_info in pkgutil.iter_modules(sql_package.__path__):
        module = importlib.import_module(f"{sql_package.__name__}.{module_info.name}")
        for name, value in vars(module).items():
            if isinstance(value, Query):
                queries[f"{module_info.name}.{name}"] = value
    return queries


QUERIES = discover_queries()


def test_queries_are_discovered():
    assert len(QUERIES) >= 28


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    for migration in MIGRATIONS:
        connection.executescript(migration.read_text())
    yield connection
    connection.close()


def table_sql(db: sqlite3.Connection, name: str) -> str:
    return db.execute("SELECT sql FROM sqlite_master WHERE name = ?", (name,)).fetchone()[0]


def check_values(db: sqlite3.Connection, table: str, column: str) -> set[str]:
    """The literal set in a column's ``CHECK (<column> IN (...))``."""
    match = re.search(rf"\b{column} TEXT[^,]*?CHECK \({column} IN \(([^)]*)\)\)", table_sql(db, table), re.DOTALL)
    assert match, f"{table}.{column} has no IN-list CHECK"
    return set(re.findall(r"'([^']*)'", match.group(1)))


def insert_event(db: sqlite3.Connection, event_id: str, state: str = "pending", **columns: object) -> None:
    row = {
        "source_id": SOURCE,
        "event_id": event_id,
        "payload_hash": HASH,
        "state": state,
        "created_at": 1,
        "updated_at": 1,
        **columns,
    }
    db.execute(f"INSERT INTO mail_events ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


@pytest.mark.parametrize("migration", MIGRATIONS, ids=lambda path: path.name)
def test_migration_has_only_statements_d1_accepts(migration):
    """D1 rejects transaction control, and each statement must stay under 100 KB."""
    code = re.sub(r"--[^\n]*", "", migration.read_text())
    assert not re.search(r"\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA|ATTACH|VACUUM)\b", code, re.IGNORECASE)
    assert max(len(statement.encode()) for statement in code.split(";")) < 100_000


def test_tables_and_indexes_are_exactly_the_planned_ones(db):
    objects = dict(db.execute("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))
    assert {name for name, kind in objects.items() if kind == "table"} == {
        "mail_events",
        "event_transitions",
        "mail_reminders",
        "summaries",
        "daily_reports",
        "owner_actions",
        "auth_failures",
        "legacy_mail_text",
        "daily_metrics",
        "gtd_snapshots",
        "gtd_snapshot_tasks",
        "gtd_daily",
        "gtd_reviews",
    }
    assert {name for name, kind in objects.items() if kind == "index"} == {
        "mail_events_due",
        "mail_events_recent",
        "mail_events_by_state",
        "mail_events_active",
        "event_transitions_event",
        "mail_reminders_sending",
        "summaries_created",
        "summaries_expiring",
        "daily_reports_day",
        "owner_actions_created",
        "legacy_mail_text_expires",
        "legacy_mail_text_created",
        "gtd_reviews_sending",
    }


def test_imported_flags_exist(db):
    for table in ("mail_events", "mail_reminders", "summaries"):
        columns = {row[1]: row for row in db.execute(f"PRAGMA table_info({table})")}
        assert columns["imported"][2:5] == ("INTEGER", 1, "0"), table


def test_state_checks_equal_the_vocabulary(db):
    states = set(EventState)
    assert check_values(db, "mail_events", "state") == states
    assert check_values(db, "event_transitions", "from_state") == states
    assert check_values(db, "event_transitions", "to_state") == states
    assert check_values(db, "mail_reminders", "state") == set(ReminderState)
    assert check_values(db, "daily_reports", "status") == set(ReportStatus) - {ReportStatus.STALE}


def test_active_index_and_payload_rule_follow_the_terminal_states(db):
    where = table_sql(db, "mail_events_active").split("WHERE", 1)[1]
    assert tuple(re.findall(r"'([^']*)'", where)) == ACTIVE_STATES
    payload_rule = re.search(r"payload IS NULL OR state NOT IN \(([^)]*)\)", table_sql(db, "mail_events"))
    assert set(re.findall(r"'([^']*)'", payload_rule.group(1))) == TERMINAL_STATES


@pytest.mark.parametrize("state", list(EventState))
def test_every_state_is_accepted(db, state):
    insert_event(db, "e1", state, payload=None if state in TERMINAL_STATES else "{}")


@pytest.mark.parametrize(
    "columns",
    [
        pytest.param({"state": "done"}, id="unknown_state"),
        pytest.param({"state": "complete", "payload": "{}"}, id="terminal_row_keeps_mail"),
        pytest.param({"payload_hash": "A" * 64}, id="hash_not_lowercase_hex"),
        pytest.param({"payload_hash": "0" * 63}, id="hash_not_sha256"),
        pytest.param({"imported": 2}, id="imported_not_a_flag"),
        pytest.param({"attempt_count": -1}, id="negative_attempts"),
    ],
)
def test_ledger_rejects_invalid_rows(db, columns):
    with pytest.raises(sqlite3.IntegrityError):
        insert_event(db, "e1", **columns)


def test_duplicate_event_is_ignored_and_keeps_the_first_hash(db):
    insert_event(db, "e1", payload_hash="a" * 64)
    db.execute(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, state, created_at, updated_at)"
        " VALUES (?, 'e1', ?, 'pending', 2, 2) ON CONFLICT DO NOTHING",
        (SOURCE, "b" * 64),
    )
    assert db.execute("SELECT payload_hash FROM mail_events").fetchall() == [("a" * 64,)]


def test_transition_from_state_may_be_null_but_actor_is_closed(db):
    db.execute("INSERT INTO event_transitions (event_id, at, to_state, actor) VALUES ('e1', 1, 'pending', 'worker')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO event_transitions (event_id, at, to_state, actor) VALUES ('e1', 1, 'pending', 'bot')")


def test_owner_action_request_id_is_unique_per_owner(db):
    insert = (
        "INSERT INTO owner_actions (owner, action_request_id, kind, request_hash, created_at)"
        " VALUES (?, 'a1', 'dismiss', ?, 1)"
    )
    db.execute(insert, ("owner@example.com", "h1"))
    db.execute(insert, ("other@example.com", "h1"))
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(insert, ("owner@example.com", "h2"))


@pytest.mark.parametrize(
    ("kind", "top_n", "status", "accepted"),
    [
        ("summary", 0, "ok", True),
        ("recommendation", 10, "model_output_invalid", True),
        ("summary", 3, "ok", False),
        ("recommendation", 0, "ok", False),
        ("recommendation", 11, "ok", False),
        ("summary", 0, "stale", False),
    ],
)
def test_daily_report_kind_top_n_and_status(db, kind, top_n, status, accepted):
    def insert() -> None:
        db.execute(
            "INSERT INTO daily_reports (kind, top_n, day, status, payload_json, task_count,"
            " window_start, window_end, computed_at) VALUES (?, ?, '2026-09-28', ?, '{}', 0, 0, 0, 0)",
            (kind, top_n, status),
        )

    if accepted:
        insert()
    else:
        with pytest.raises(sqlite3.IntegrityError):
            insert()


def test_legacy_text_expiry_is_optional(db):
    db.execute("INSERT INTO legacy_mail_text (event_id, created_at, text) VALUES ('legacy:1', 1, 'body')")
    assert db.execute("SELECT expires_at FROM legacy_mail_text").fetchone() == (None,)


def test_keyset_pages_walk_ties_without_gaps_or_repeats(db):
    for index in range(5):
        insert_event(db, f"e{index}", created_at=100)
    insert_event(db, "e9", created_at=50)
    sql = views.RECENT_PAGE.sql
    seen, cursor = [], (2**62, "")
    while page := db.execute(sql, (SOURCE, *cursor, 2)).fetchall():
        seen += [row[0] for row in page]
        last = page[-1][0]
        cursor = (db.execute("SELECT created_at FROM mail_events WHERE event_id = ?", (last,)).fetchone()[0], last)
    assert seen == ["e4", "e3", "e2", "e1", "e0", "e9"]


def test_attention_page_uses_the_vocabulary_rule(db):
    now = 100_000
    cutoff = now - 6 * 3600
    insert_event(db, "old-pending", "pending", payload="{}", created_at=cutoff - 1)
    insert_event(db, "new-pending", "pending", payload="{}", created_at=now)
    insert_event(db, "new-failed", "failed_summary", payload="{}", created_at=now)
    insert_event(db, "old-complete", "complete", created_at=0)
    sql = views.ATTENTION_PAGE.sql
    rows = db.execute(sql, (SOURCE, cutoff, -1, "", 10)).fetchall()
    assert [row[0] for row in rows] == ["old-pending", "new-failed"]
    count_sql = views.ATTENTION_COUNT.sql
    assert db.execute(count_sql, (SOURCE, cutoff)).fetchone() == (2,)


def test_ops_columns_are_additive_and_checked(db):
    """0003_ops.sql: rows written before it read NULL / 0; a run ID is 1-64 characters."""
    insert_event(db, "real", payload="{}")
    assert db.execute("SELECT canary_run_id FROM mail_events").fetchall() == [(None,)]
    insert_event(db, "canary", payload="{}", canary_run_id="canary-2026-09-29")
    for bad in ("", "x" * 65):
        with pytest.raises(sqlite3.IntegrityError):
            insert_event(db, f"bad-{len(bad)}", payload="{}", canary_run_id=bad)
    db.execute(
        "INSERT INTO mail_reminders (day, state, attention_count, created_at, updated_at)"
        " VALUES ('2026-09-29', 'created', 0, 1, 1)"
    )
    assert db.execute("SELECT ops_count, ops_generated_at FROM mail_reminders").fetchall() == [(0, 0)]


def test_canary_events_are_never_listed_counted_or_reminded_of(db):
    now = 100_000
    cutoff = now - 6 * 3600
    for prefix, run in (("real", None), ("canary", "canary-1")):
        insert_event(db, f"{prefix}-failed", "failed_summary", payload="{}", created_at=now, canary_run_id=run)
        insert_event(db, f"{prefix}-old", "pending", payload="{}", created_at=cutoff - 1, canary_run_id=run)
        insert_event(db, f"{prefix}-done", "complete", created_at=now, canary_run_id=run)
    listed = {
        "attention_page": db.execute(views.ATTENTION_PAGE.sql, (SOURCE, cutoff, -1, "", 10)).fetchall(),
        "recent": db.execute(views.RECENT_PAGE.sql, (SOURCE, 2**52, "", 10)).fetchall(),
        "recent_by_state": db.execute(views.RECENT_PAGE_BY_STATE.sql, (SOURCE, "complete", 2**52, "", 10)).fetchall(),
        "reminder_rows": db.execute(reminder_sql.ATTENTION_ROWS.sql, (SOURCE, cutoff, 20)).fetchall(),
    }
    for name, rows in listed.items():
        assert rows and all(row[0].startswith("real-") for row in rows), name
    assert db.execute(views.ATTENTION_COUNT.sql, (SOURCE, cutoff)).fetchone() == (2,)
    assert db.execute(reminder_sql.ATTENTION_COUNT.sql, (SOURCE, cutoff)).fetchone() == (2,)
    assert dict(db.execute(views.ACTIVE_COUNTS.sql, (SOURCE,)).fetchall()) == {"failed_summary": 1, "pending": 1}
    assert db.execute(views.RECEIVED_SINCE.sql, (SOURCE, 0)).fetchone() == (3,)
    assert db.execute(views.OLDEST_DUE.sql, (now,)).fetchone() == (cutoff - 1,)


def test_the_metrics_walk_sees_which_arrivals_and_completions_are_canaries(db):
    insert_event(db, "real", "complete", created_at=10)
    insert_event(db, "canary", "complete", created_at=20, canary_run_id="canary-1")
    for event_id, at, from_state, to_state in (
        ("real", 10, None, "pending"),
        ("canary", 20, None, "pending"),
        ("canary", 21, "pending", "summarizing"),
        ("canary", 22, "summarizing", "complete"),
        ("real", 30, "todo_sending", "complete"),
    ):
        db.execute(
            "INSERT INTO event_transitions (event_id, at, from_state, to_state, actor) VALUES (?, ?, ?, ?, 'worker')",
            (event_id, at, from_state, to_state),
        )
    rows = db.execute(metrics_sql.TRANSITIONS_AFTER.sql, (SOURCE, 0, 10)).fetchall()
    assert [(row[1], row[4], row[5], row[6]) for row in rows] == [
        ("real", "pending", 10, None),
        ("canary", "pending", 20, "canary-1"),
        ("canary", "summarizing", None, None),
        ("canary", "complete", 20, "canary-1"),
        ("real", "complete", 10, None),
    ]


# Rows from bound values: VALUES, or json_each over one bound JSON text.
INSERT_BOUND = re.compile(r"INSERT INTO (\w+) \([^)]*\) (?:VALUES |SELECT .+ FROM json_each\(\?\))")


@pytest.mark.parametrize("name", QUERIES)
def test_query_uses_its_index(db, name):
    sql, index, sort_allowed = QUERIES[name]
    plan = [row[3] for row in db.execute(f"EXPLAIN QUERY PLAN {sql}", (None,) * sql.count("?"))]
    if index == "rowid":
        # Only rowid lookups or ranges (max(rowid) plans as a bare SEARCH), never an index or a scan.
        assert plan and all(step.startswith("SEARCH") and "INDEX" not in step for step in plan), plan
        return
    if (insert := INSERT_BOUND.match(sql)) is not None:
        # Inserting bound values reads no table; the statement must name a unique key of its table.
        assert all(step.startswith("SCAN json_each VIRTUAL TABLE") for step in plan), plan
        unique = {row[1] for row in db.execute(f"PRAGMA index_list({insert.group(1)})") if row[2]}
        assert index in unique, unique
        return
    partial = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE sql LIKE '%INDEX%WHERE%'")}
    assert any(re.search(rf"\bINDEX {index}\b", step) for step in plan), plan
    for step in plan:
        used = re.search(r"INDEX (\w+)", step)
        bounded = used is not None and used.group(1) in partial
        # A SCAN reads a whole table or index. source_id is a constant, so a
        # search on it alone does too, unless LIMIT stops an in-order walk.
        if step.startswith("SCAN") or (step.endswith("(source_id=?)") and "LIMIT" not in sql):
            assert bounded, plan
    if not sort_allowed:
        assert not any("TEMP B-TREE" in step for step in plan), plan
