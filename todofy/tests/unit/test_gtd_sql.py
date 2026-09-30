"""migrations/0004_gtd.sql and the GTD statements on host SQLite (D1 is SQLite): checks, what the
carryover and the aggregate reads return, and that the previous release's SQL keeps working."""

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from todofy.core import gtd
from todofy.core.sql import gtd as sql
from todofy.core.sql import reminders as reminder_sql
from todofy.core.sql import reports as report_sql
from todofy.core.sql import retention as retention_sql

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
KEY = bytes(32)
DAY = 86_400
NOW = 1_790_600_000
TODAY = gtd.day_of(NOW)


def migrated(upto: str | None = None) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        if upto is not None and migration.name > upto:
            break
        connection.executescript(migration.read_text())
    return connection


@pytest.fixture
def db() -> Iterator[sqlite3.Connection]:
    connection = migrated()
    yield connection
    connection.close()


def write_page(db: sqlite3.Connection, day: str, tasks: list[dict]) -> None:
    rows, _ = gtd.snapshot_rows(tasks, KEY)
    db.execute(sql.WRITE_PAGE.sql, (day, json.dumps(rows)))


def task(task_id: str, **fields: object) -> dict[str, object]:
    return {"id": task_id, "project_id": "inbox", "content": "t", "description": "", **fields}


def test_a_page_is_written_in_one_statement_and_rewritten_idempotently(db):
    tasks = [
        task("a", labels=["x", "y"], priority=4, due={"date": "2026-10-01"}, added_at="2026-09-20T00:00:00Z"),
        task("b", parent_id="a", due={"date": "2026-10-01T09:00:00Z", "is_recurring": True}),
    ]
    write_page(db, TODAY, tasks)
    write_page(db, TODAY, [task("a", priority=2)])  # the same day again: the later row wins
    rows = [dict(row) for row in db.execute("SELECT * FROM gtd_snapshot_tasks ORDER BY task_id")]
    assert [(row["task_id"], row["priority"], row["labels"]) for row in rows] == [("a", 2, "[]"), ("b", 1, "[]")]
    assert rows[1]["parent_id"] == "a" and rows[1]["due_recurring"] == 1 and rows[1]["due_at"] is not None
    first = db.execute(sql.SNAPSHOT_ROWS.sql, (TODAY, gtd.MAX_SNAPSHOT_ROWS)).fetchone()
    assert set(first.keys()) == {
        "project_id",
        "parent_id",
        "priority",
        "due_date",
        "due_at",
        "due_recurring",
        "deadline_date",
        "added_at",
    }


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("priority", 5),
        ("checked", 2),
        ("content_hmac", "A" * 64),
        ("content_hmac", "0" * 63),
        ("labels", "[" + "1," * 1100 + "1]"),
        ("due_date", "tomorrow"),
        ("task_id", ""),
    ],
)
def test_snapshot_rows_are_checked(db, column, value):
    row = {"day": TODAY, "task_id": "t", "project_id": "p", "priority": 1, "content_hmac": "0" * 64} | {column: value}
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            f"INSERT INTO gtd_snapshot_tasks ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
            tuple(row.values()),
        )


def test_the_snapshot_row_restarts_on_a_new_attempt(db):
    db.execute(sql.SNAPSHOT_START.sql, (TODAY, NOW))
    db.execute(sql.SNAPSHOT_FINISH.sql, ("failed", 0, 1, 2, "todoist_unavailable", NOW + 5, TODAY))
    db.execute(sql.SNAPSHOT_START.sql, (TODAY, NOW + 600))
    row = dict(db.execute("SELECT * FROM gtd_snapshots").fetchone())
    assert row == {
        "day": TODAY,
        "status": "collecting",
        "task_count": 0,
        "skipped": 0,
        "pages": 0,
        "error_code": "",
        "started_at": NOW + 600,
        "finished_at": None,
    }
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(sql.SNAPSHOT_FINISH.sql, ("done", 0, 0, 0, "", NOW, TODAY))


def test_clear_day_removes_only_that_day(db):
    write_page(db, TODAY, [task("a"), task("b")])
    write_page(db, gtd.shift(TODAY, -1), [task("a")])
    db.execute(sql.CLEAR_DAY.sql, (TODAY, gtd.MAX_SNAPSHOT_ROWS))
    assert [tuple(row) for row in db.execute("SELECT day, task_id FROM gtd_snapshot_tasks")] == [
        (gtd.shift(TODAY, -1), "a")
    ]


def test_closed_since_counts_tasks_gone_since_yesterday(db):
    yesterday = gtd.shift(TODAY, -1)
    write_page(db, yesterday, [task("a"), task("b"), task("c")])
    write_page(db, TODAY, [task("b"), task("d")])
    assert db.execute(sql.CLOSED_SINCE.sql, (yesterday, TODAY)).fetchone()[0] == 2


def summary(db: sqlite3.Connection, event_id: str, created_at: int, task_id: str, text: str) -> None:
    db.execute(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id) VALUES (?, ?, 's', ?, 'm', ?)",
        (event_id, created_at, text, task_id),
    )


def test_carryover_is_older_open_mail_newest_first_and_capped(db):
    write_page(db, TODAY, [task(f"t{index}") for index in range(40)])
    summary(db, "in-window", NOW - 3600, "t0", "今天的")
    summary(db, "edge", NOW - DAY, "t1", "正好 24 小时")  # the window is (now-24h, now]: carried
    summary(db, "closed", NOW - 2 * DAY, "gone", "已完成")
    summary(db, "no-task", NOW - 2 * DAY, "", "没有任务")
    summary(db, "too-old", NOW - 14 * DAY, "t2", "太旧")
    for index in range(3, 40):
        summary(db, f"e{index}", NOW - DAY - 60 * index, f"t{index}", f"摘要 {index}")
    rows = db.execute(report_sql.CARRYOVER.sql, (NOW - 14 * DAY, NOW - DAY, TODAY, gtd.CARRYOVER_MAX_ROWS)).fetchall()
    assert [row["summary"] for row in rows] == ["正好 24 小时"] + [f"摘要 {index}" for index in range(3, 32)]
    assert len(rows) == gtd.CARRYOVER_MAX_ROWS
    count = db.execute(sql.MAIL_OPEN.sql, (NOW - 14 * DAY, NOW, TODAY)).fetchone()[0]
    assert count == 1 + 1 + 37  # in the window, the edge, e3..e39; not closed, taskless or too old


def test_only_a_fresh_ok_snapshot_serves_the_carryover(db):
    def latest(now: int) -> str | None:
        fresh = now - gtd.SNAPSHOT_FRESH
        found = db.execute(report_sql.LATEST_OK_SNAPSHOT.sql, (gtd.day_of(fresh), gtd.day_of(now), fresh)).fetchone()
        return None if found is None else found["day"]

    yesterday = gtd.shift(TODAY, -1)
    db.execute(sql.SNAPSHOT_START.sql, (yesterday, NOW - DAY))
    db.execute(sql.SNAPSHOT_FINISH.sql, ("ok", 1, 0, 1, "", NOW - DAY, yesterday))
    db.execute(sql.SNAPSHOT_START.sql, (TODAY, NOW))
    assert latest(NOW) == yesterday  # today's is still collecting
    db.execute(sql.SNAPSHOT_FINISH.sql, ("partial", 2000, 0, 10, "page_cap", NOW, TODAY))
    assert latest(NOW) == yesterday
    assert latest(NOW - DAY + gtd.SNAPSHOT_FRESH + 1) is None  # 26 h after it finished: stale
    db.execute(sql.SNAPSHOT_FINISH.sql, ("ok", 2, 0, 1, "", NOW, TODAY))
    assert latest(NOW) == TODAY


def test_daily_rows_upsert_and_read_back(db):
    values = [TODAY, "all", 5, 1, 1, 1, 1, 40, 2, 3, None, None, "none", None, 4, 1, NOW]
    db.execute(sql.WRITE_DAILY.sql, values)
    db.execute(sql.WRITE_DAILY.sql, [*values[:2], 6, *values[3:]])
    [row] = db.execute(sql.DAILY_RANGE.sql, (TODAY, TODAY, 4)).fetchall()
    assert gtd.daily_from_row(dict(row)).open == 6 and gtd.daily_from_row(dict(row)).completed_7d is None
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(sql.WRITE_DAILY.sql, [TODAY, "work", *values[2:]])


def test_a_review_week_is_claimed_once_and_finished_from_sending(db):
    claim = (sql.CLAIM_REVIEW.sql, ("2026-W40", "review", "每周回顾 2026-W40", "body", NOW, NOW))
    assert db.execute(*claim).rowcount == 1
    assert db.execute(*claim).rowcount == 0
    db.execute(sql.FINISH_REVIEW.sql, ("failed", "", NOW + 3600, "review_create_failed", NOW, "2026-W40"))
    assert db.execute(sql.CLAIM_REVIEW_RETRY.sql, (NOW + 3600, "2026-W40", 1, NOW + 3600)).rowcount == 1
    assert db.execute(sql.RECOVER_REVIEW.sql, ("interrupted_review_call", NOW)).rowcount == 1
    row = dict(db.execute(sql.REVIEW_WEEK.sql, ("2026-W40",)).fetchone())
    assert (row["state"], row["attempts"], row["project_id"]) == ("unknown", 2, "review")
    for bad in ("2026-40", "2026-W4"):
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(sql.CLAIM_REVIEW.sql, (bad, "", "t", "b", NOW, NOW))


def test_open_reviews_and_their_completion(db):
    for week, state, task_id in (
        ("2026-W38", "created", "r38"),
        ("2026-W39", "unknown", ""),
        ("2026-W40", "created", "r40"),
    ):
        db.execute(sql.CLAIM_REVIEW.sql, (week, "", "t", "b", NOW, NOW))
        db.execute(sql.FINISH_REVIEW.sql, (state, task_id, 0, "", NOW, week))
    assert [tuple(row) for row in db.execute(sql.OPEN_REVIEWS.sql, ("2026-W37",))] == [
        ("2026-W38", "r38"),
        ("2026-W40", "r40"),
    ]
    db.execute(sql.REVIEW_DONE.sql, (NOW + 5, NOW + 5, "2026-W40", "r40"))
    assert [tuple(row) for row in db.execute(sql.OPEN_REVIEWS.sql, ("2026-W37",))] == [("2026-W38", "r38")]
    history = [dict(row) for row in db.execute(sql.REVIEW_HISTORY.sql, ("2026-W30", 13))]
    assert [(row["week"], row["completed_at"]) for row in history] == [
        ("2026-W40", NOW + 5),
        ("2026-W39", None),
        ("2026-W38", None),
    ]


def test_retention_deletes_only_expired_gtd_rows(db):
    old, kept = gtd.shift(TODAY, -15), gtd.shift(TODAY, -14)
    write_page(db, old, [task("a"), task("b")])
    write_page(db, kept, [task("a")])
    for day in (gtd.shift(TODAY, -121), gtd.shift(TODAY, -120)):
        db.execute(sql.SNAPSHOT_START.sql, (day, NOW))
        db.execute(sql.WRITE_DAILY.sql, [day, "all", 0, 0, 0, 0, 0, 0, 0, 0, None, None, "none", None, None, 1, NOW])
    db.execute(sql.CLAIM_REVIEW.sql, ("2025-W30", "", "t", "b", NOW, NOW))
    db.execute(sql.CLAIM_REVIEW.sql, ("2026-W40", "", "t", "b", NOW, NOW))
    db.execute(retention_sql.EXPIRE_GTD_TASKS.sql, (gtd.day_of(NOW - 14 * DAY), 1000))
    db.execute(retention_sql.EXPIRE_GTD_SNAPSHOTS.sql, (gtd.day_of(NOW - 120 * DAY), 100))
    db.execute(retention_sql.EXPIRE_GTD_DAILY.sql, (gtd.day_of(NOW - 120 * DAY), 100))
    db.execute(retention_sql.EXPIRE_GTD_REVIEWS.sql, (gtd.iso_week(NOW - 400 * DAY), 100))
    assert [tuple(row) for row in db.execute("SELECT DISTINCT day FROM gtd_snapshot_tasks")] == [(kept,)]
    assert [tuple(row) for row in db.execute("SELECT day FROM gtd_snapshots")] == [(gtd.shift(TODAY, -120),)]
    assert [tuple(row) for row in db.execute("SELECT day FROM gtd_daily")] == [(gtd.shift(TODAY, -120),)]
    assert [tuple(row) for row in db.execute("SELECT week FROM gtd_reviews")] == [("2026-W40",)]


# The reminder claim of the release before 0004, verbatim: it must keep working after the migration
# (a rollback runs it against the migrated database) and its rows read as "no frozen project".
PREVIOUS_CLAIM_DAY = (
    "INSERT INTO mail_reminders"
    " (day, state, subject, body, attention_count, ops_count, ops_generated_at, created_at, updated_at)"
    " VALUES (?, 'sending', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day) DO NOTHING"
)
PREVIOUS_REMINDER_DAY = (
    "SELECT state, attempts, next_attempt_at, subject, body, ops_count FROM mail_reminders WHERE day = ?"
)


def test_0004_is_additive_on_a_populated_0003_database():
    db = migrated(upto="0003_ops.sql")
    db.execute(PREVIOUS_CLAIM_DAY, ("2026-09-29", "t", "b", 1, 0, 0, NOW, NOW))
    db.executescript((Path(MIGRATIONS[0]).parent / "0004_gtd.sql").read_text())
    db.execute(PREVIOUS_CLAIM_DAY, ("2026-09-30", "t", "b", 1, 0, 0, NOW, NOW))
    assert db.execute(PREVIOUS_REMINDER_DAY, ("2026-09-30",)).fetchone()["state"] == "sending"
    rows = db.execute("SELECT day, project_id FROM mail_reminders ORDER BY day").fetchall()
    assert [tuple(row) for row in rows] == [("2026-09-29", ""), ("2026-09-30", "")]
    db.execute(reminder_sql.CLAIM_DAY.sql, ("2026-10-01", "t", "b", 1, 0, 0, "ops-project", NOW, NOW))
    assert db.execute(reminder_sql.REMINDER_DAY.sql, ("2026-10-01",)).fetchone()["project_id"] == "ops-project"
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(reminder_sql.CLAIM_DAY.sql, ("2026-10-02", "t", "b", 1, 0, 0, "p" * 65, NOW, NOW))
