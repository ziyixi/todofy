"""core/carryover.py: which pending mail the morning brief carries, and its lines (synthetic summaries only)."""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from todofy.core import carryover
from todofy.core.sql import reports as report_sql

MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
NOW = int(datetime(2026, 10, 4, 13, tzinfo=UTC).timestamp())
DAY = 86_400


def test_carried_lines_say_how_many_days_ago():
    assert carryover.carried_line("缴费", NOW, NOW - DAY - 5) == "[1 天前] 缴费"
    assert carryover.carried_line("缴费", NOW, NOW - 13 * DAY) == "[13 天前] 缴费"
    assert carryover.carried_line("缴费", NOW, NOW - 3600) == "[1 天前] 缴费"  # never "0 days"
    # A long stored summary (up to 64 KiB) is cut on a UTF-8 boundary.
    long = carryover.carried_line("缴" * 2000, NOW, NOW - 2 * DAY)
    assert long.startswith("[2 天前] 缴")
    assert len(long.encode()) <= carryover.CARRYOVER_LINE_BYTES + len("[2 天前] ".encode())
    long.encode().decode()


def candidates(now: int, per_day: dict[int, int]) -> list[dict[str, object]]:
    """``per_day`` maps "N 天前" to how much pending mail arrived that day."""
    rows = []
    for days, count in per_day.items():
        for index in range(count):
            rows.append({"event_id": f"d{days}-{index}", "created_at": now - days * DAY - 60 * (index + 1)})
    return rows


def test_the_carryover_is_spread_over_the_days_oldest_day_first():
    # A normal week: 40 pending mail from yesterday, 5 from 2 days ago, 2 each from 9 and 13 days ago.
    picked = carryover.pick_carried(candidates(NOW, {1: 40, 2: 5, 9: 2, 13: 2}), NOW)
    assert len(picked) == carryover.CARRYOVER_MAX_ROWS
    days = {day: sum(event.startswith(f"d{day}-") for event in picked) for day in (1, 2, 9, 13)}
    # Every older mail is carried; yesterday's fill the rest, newest first.
    assert days == {1: 21, 2: 5, 9: 2, 13: 2}
    assert picked[:4] == ["d13-0", "d9-0", "d2-0", "d1-0"]
    assert [event for event in picked if event.startswith("d1-")] == [f"d1-{index}" for index in range(21)]
    # More days than slots in a round: the oldest days go first.
    many = carryover.pick_carried(candidates(NOW, {day: 5 for day in range(1, 14)}), NOW, cap=15)
    assert sorted({int(event[1:].split("-")[0]) for event in many[:13]}) == list(range(1, 14))
    assert many[13:] == ["d13-1", "d12-1"]
    assert carryover.pick_carried([], NOW) == []


def test_carried_lines_keep_the_pick_order_until_the_byte_cap_then_newest_first():
    rows = [
        {"event_id": "old", "summary": "旧", "created_at": NOW - 9 * DAY},
        {"event_id": "new", "summary": "新", "created_at": NOW - DAY - 60},
    ]
    assert carryover.carried_lines(rows, ["old", "new", "gone"], NOW) == ["[1 天前] 新", "[9 天前] 旧"]
    big = [{"event_id": f"e{i}", "summary": "长" * 400, "created_at": NOW - (2 + i) * DAY} for i in range(30)]
    lines = carryover.carried_lines(big, [f"e{i}" for i in range(30)], NOW)
    assert sum(len(line.encode()) + 1 for line in lines) <= carryover.CARRYOVER_MAX_BYTES
    # The cap keeps the first picks in pick order (e0, e1, ...), shown newest first.
    assert 0 < len(lines) < 30
    assert lines[0].startswith("[2 天前]") and lines[-1].startswith(f"[{1 + len(lines)} 天前]")


def summary(db: sqlite3.Connection, event_id: str, created_at: int, text: str, **columns: object) -> None:
    row = {"event_id": event_id, "created_at": created_at, "subject": "s", "summary": text, "model": "m", **columns}
    db.execute(f"INSERT INTO summaries ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


def test_the_candidates_are_older_pending_mail_and_the_picks_are_read_by_id():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    for migration in MIGRATIONS:
        db.executescript(migration.read_text())
    summary(db, "in-window", NOW - 3600, "今天的")
    summary(db, "edge", NOW - DAY, "正好 24 小时")  # the window is (now-24h, now]: carried
    summary(db, "converted", NOW - 2 * DAY, "已转成任务", task_id="t-done", triaged_at=NOW - DAY)
    summary(db, "imported", NOW - 2 * DAY, "导入的", imported=1)
    summary(db, "too-old", NOW - 14 * DAY, "太旧")
    for index in range(3, 40):
        summary(db, f"e{index}", NOW - DAY - 60 * index, f"摘要 {index}")
    summary(db, "long", NOW - 3 * DAY, "长" * 5000)
    bind = (NOW - 14 * DAY, NOW - DAY, carryover.MAX_CANDIDATES)
    rows = [dict(row) for row in db.execute(report_sql.CARRYOVER_CANDIDATES.sql, bind)]
    # IDs and times only, newest first, every pending one (the cap of 30 is pick_carried's).
    assert set(rows[0]) == {"event_id", "created_at"}
    assert [row["event_id"] for row in rows] == ["edge"] + [f"e{index}" for index in range(3, 40)] + ["long"]
    order = carryover.pick_carried(rows, NOW)
    assert len(order) == carryover.CARRYOVER_MAX_ROWS and order[0] == "long"  # the oldest day first
    ids = order + [""] * (carryover.CARRYOVER_MAX_ROWS - len(order))
    picked = {
        row["event_id"]: row["summary"]
        for row in db.execute(report_sql.CARRYOVER_SUMMARIES.sql, (carryover.CARRYOVER_READ_CHARS, *ids))
    }
    assert set(picked) == set(order) and len(picked["long"]) == carryover.CARRYOVER_READ_CHARS
    # Unused places are bound to '' and match nothing.
    assert list(db.execute(report_sql.CARRYOVER_SUMMARIES.sql, (10, "edge", *[""] * 29))) != []
