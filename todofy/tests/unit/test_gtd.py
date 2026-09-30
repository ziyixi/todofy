"""core/gtd.py: snapshot rows, aggregates, schedules and the review text (synthetic tasks only)."""

import json
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from todofy.core import gtd
from todofy.core.ops import DigestItem, OpsDigest

KEY = bytes(range(32))
SENTINEL = "SENTINEL-合成标题-7f3a"
SECRET_DESC = "SENTINEL-合成描述-19c2"
# Sunday 2026-10-04 13:00 UTC: the day's snapshot.
NOW = int(datetime(2026, 10, 4, 13, tzinfo=UTC).timestamp())
DAY = 86_400


def stamp(seconds: int) -> str:
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def task(**fields: object) -> dict[str, object]:
    return {
        "id": "6Xtask0001",
        "project_id": "inbox",
        "parent_id": None,
        "section_id": None,
        "labels": ["waiting"],
        "priority": 1,
        "due": None,
        "deadline": None,
        "added_at": stamp(NOW - 3 * DAY),
        "checked": False,
        "is_deleted": False,
        "content": SENTINEL,
        "description": SECRET_DESC,
        "note_count": 2,
        "postponed_count": 1,
        **fields,
    }


# ---- snapshot rows -------------------------------------------------------------------------


def test_a_row_keeps_only_the_whitelist_and_never_the_text():
    row = gtd.snapshot_row(task(), KEY)
    assert tuple(row) == gtd.ROW_KEYS
    assert row == {
        "task_id": "6Xtask0001",
        "project_id": "inbox",
        "parent_id": None,
        "labels": '["waiting"]',
        "priority": 1,
        "due_date": None,
        "due_at": None,
        "due_recurring": 0,
        "deadline_date": None,
        "added_at": NOW - 3 * DAY,
        "checked": 0,
        "content_hmac": gtd.content_hmac(KEY, SENTINEL, SECRET_DESC),
    }
    text = json.dumps(row, ensure_ascii=False)
    assert SENTINEL not in text and SECRET_DESC not in text and "SENTINEL" not in text


def test_the_content_hash_is_keyed_and_stable():
    first = gtd.content_hmac(KEY, "Pay rent", "")
    assert first == gtd.content_hmac(KEY, "Pay rent", "")
    assert len(first) == 64 and all(char in "0123456789abcdef" for char in first)
    assert first != gtd.content_hmac(bytes(32), "Pay rent", "")  # another key, another hash
    assert first != gtd.content_hmac(KEY, "Pay rent", "x")  # the description counts
    assert gtd.content_hmac(KEY, None, None) == gtd.content_hmac(KEY, "", "")


@pytest.mark.parametrize(
    ("due", "expected"),
    [
        (None, (None, None, False)),
        ({"date": "2026-10-05", "is_recurring": False, "string": "tomorrow"}, ("2026-10-05", None, False)),
        ({"date": "2026-10-05T09:30:00", "is_recurring": True}, ("2026-10-05", None, True)),  # floating
        (
            {"date": "2026-10-05T16:30:00Z", "timezone": "America/Los_Angeles"},
            ("2026-10-05", int(datetime(2026, 10, 5, 16, 30, tzinfo=UTC).timestamp()), False),
        ),
        (
            {"date": "2026-10-05", "datetime": "2026-10-05T01:00:00Z"},
            ("2026-10-05", int(datetime(2026, 10, 5, 1, tzinfo=UTC).timestamp()), False),
        ),
    ],
)
def test_due_forms(due, expected):
    assert gtd.parse_due(due) == expected


@pytest.mark.parametrize(
    "fields",
    [
        {"id": None},
        {"id": ""},
        {"id": "x" * 65},
        {"id": 12},
        {"project_id": None},
        {"priority": 0},
        {"priority": 5},
        {"priority": True},
        {"due": "tomorrow"},
        {"due": {"date": "not a date"}},
        {"due": {"date": "2026-13-40"}},
        {"deadline": {"date": "soon"}},
        {"parent_id": 7},
    ],
)
def test_malformed_tasks_are_skipped(fields):
    rows, skipped = gtd.snapshot_rows([task(**fields), task(id="ok")], KEY)
    assert [row["task_id"] for row in rows] == ["ok"] and skipped == 1


def test_unknown_added_at_is_kept_as_null_and_labels_are_bounded():
    row = gtd.snapshot_row(task(added_at=None, labels=["x" * 300] * 20), KEY)
    assert row["added_at"] is None
    assert len(row["labels"].encode()) <= gtd.MAX_LABELS_BYTES and json.loads(row["labels"])
    assert gtd.snapshot_row(task(added_at="yesterday"), KEY)["added_at"] is None
    assert gtd.snapshot_row(task(labels="not a list"), KEY)["labels"] == "[]"
    assert gtd.snapshot_row(task(deadline={"date": "2026-10-10"}), KEY)["deadline_date"] == "2026-10-10"


def test_a_task_listed_twice_in_a_page_is_kept_once():
    rows, skipped = gtd.snapshot_rows([task(priority=1), task(priority=4)], KEY)
    assert [(row["task_id"], row["priority"]) for row in rows] == [("6Xtask0001", 4)] and skipped == 0


# ---- page parsers --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (b'{"items": [{"id": "a"}], "next_cursor": "c.1"}', ([{"id": "a"}], "c.1")),
        (b'{"items": [{"id": "a"}]}', ([{"id": "a"}], "")),  # omitted on the last page
        (b'{"items": [], "next_cursor": null}', ([], "")),
    ],
)
def test_completed_pages(body, expected):
    assert gtd.parse_completed_page(body) == expected


@pytest.mark.parametrize(
    "body", [b"[]", b'{"results": []}', b'{"items": [1]}', b'{"items": [], "next_cursor": 3}', b"x"]
)
def test_unexpected_completed_pages_are_refused(body):
    with pytest.raises(ValueError):
        gtd.parse_completed_page(body)


def test_the_completed_tally_counts_scopes_recent_additions_and_reviews():
    since = NOW - 7 * DAY
    items = [
        {"id": "r1", "project_id": "review", "added_at": stamp(NOW - 2 * DAY), "completed_at": stamp(NOW - DAY)},
        {"id": "i1", "project_id": "inbox", "added_at": stamp(NOW - 10 * DAY), "completed_at": stamp(NOW - 3600)},
        {"id": "i2", "project_id": "inbox", "added_at": None, "content": SENTINEL},
    ]
    tally = gtd.tally_completed(gtd.CompletedTally(), items, since=since, inbox="inbox", review_ids=["r1", "zz"])
    assert tally == gtd.CompletedTally(3, 2, 1, 0, {"r1": NOW - DAY})
    again = gtd.tally_completed(tally, items[1:2], since=since, inbox="", review_ids=[])
    assert (again.total, again.inbox) == (4, 2)  # no inbox configured: nothing is inbox
    assert gtd.CompletedTally.loads(tally.dumps()) == tally
    assert SENTINEL not in tally.dumps()
    assert gtd.CompletedTally.loads("{}") is None and gtd.CompletedTally.loads(None) is None


# ---- aggregates ----------------------------------------------------------------------------


def snap(task_id: str, **fields: object) -> dict[str, object]:
    return {"task_id": task_id, "project_id": "inbox", "due_date": None, "due_at": None, "added_at": NOW} | fields


@pytest.mark.parametrize(
    ("days", "bucket"),
    [(0, 0), (7, 0), (8, 1), (14, 1), (15, 2), (30, 2), (31, 3), (400, 3)],
)
def test_age_bucket_boundaries(days, bucket):
    # One second short of the next day: the age is still ``days``.
    daily = gtd.aggregate(
        [snap("t", added_at=NOW - days * DAY - (DAY - 1))], now=NOW, scope_project=None, completed=None, complete=True
    )
    buckets = [daily.age_0_7, daily.age_8_14, daily.age_15_30, daily.age_31_plus]
    assert buckets == [int(index == bucket) for index in range(4)] and daily.oldest_days == days


def test_overdue_undated_and_scopes():
    today = gtd.day_of(NOW)
    rows = [
        snap("date-yesterday", due_date=gtd.shift(today, -1)),
        snap("date-today", due_date=today),  # not overdue: the day is not over
        snap("zoned-past", due_date=today, due_at=NOW - 60),
        snap("zoned-future", due_date=today, due_at=NOW + 60),
        snap("deadline-only", deadline_date=gtd.shift(today, -3)),  # undated: a deadline alone is no due
        snap("elsewhere", project_id="work", added_at=None, due_date=gtd.shift(today, -9)),
    ]
    every = gtd.aggregate(rows, now=NOW, scope_project=None, completed=None, complete=True, closed_1d=2, mail_open=4)
    assert (every.open, every.overdue, every.undated) == (6, 3, 1)
    assert (every.completed_7d, every.created_7d, every.completed_source) == (None, None, "none")
    assert (every.closed_1d, every.mail_open) == (2, 4)
    # Unknown added_at counts in no bucket, so buckets may sum below open.
    assert every.age_0_7 == 5
    inbox = gtd.aggregate(rows, now=NOW, scope_project="inbox", completed=None, complete=True, closed_1d=2)
    assert (inbox.open, inbox.overdue, inbox.undated, inbox.closed_1d, inbox.mail_open) == (5, 2, 1, None, None)


def test_created_and_completed_merge_the_completed_window():
    rows = [snap("new", added_at=NOW - DAY), snap("old", added_at=NOW - 8 * DAY), snap("w", project_id="work")]
    tally = gtd.CompletedTally(total=5, inbox=2, added_recent_total=3, added_recent_inbox=1)
    every = gtd.aggregate(rows, now=NOW, scope_project=None, completed=tally, complete=True)
    inbox = gtd.aggregate(rows, now=NOW, scope_project="inbox", completed=tally, complete=True)
    assert (every.completed_7d, every.created_7d, every.completed_source) == (5, 2 + 3, "api")
    assert (inbox.completed_7d, inbox.created_7d) == (2, 1 + 1)


def test_status_counters_leave_out_what_is_unknown():
    every = gtd.aggregate([snap("a")], now=NOW, scope_project=None, completed=None, complete=True, mail_open=3)
    inbox = gtd.aggregate([snap("a")], now=NOW, scope_project="inbox", completed=None, complete=True)
    assert gtd.status_counters(every, inbox) == {
        "inbox_open": 1,
        "inbox_oldest_days": 0,
        "overdue": 0,
        "carryover_open": 3,
    }
    assert gtd.status_counters(every, None) == {"overdue": 0, "carryover_open": 3}
    assert gtd.status_counters(replace(every, complete=False), inbox) == {}
    done = replace(every, completed_7d=9)
    assert gtd.status_counters(done, inbox)["completed_7d"] == 9


def test_facts_for_the_two_signals():
    facts = gtd.GtdFacts(collect_enabled=True, review_enabled=True)
    assert gtd.snapshot_age(facts, NOW) is None  # never attempted: nothing to call stale
    tried = replace(facts, first_attempt_at=NOW - 48 * 3600)
    assert gtd.snapshot_age(tried, NOW) is None and gtd.snapshot_age(tried, NOW + 1) == 48 * 3600 + 1
    ok = replace(tried, last_ok_at=NOW - 3600)
    assert gtd.snapshot_age(ok, NOW + 47 * 3600) is None and gtd.snapshot_age(ok, NOW + 48 * 3600) == 49 * 3600
    assert gtd.snapshot_age(replace(tried, collect_enabled=False), NOW + DAY) is None
    assert gtd.review_age_days(facts, NOW) is None
    # A review is only seen done by the daily snapshot: with collection off (or paused), or the review
    # switched off, neither review_age_days nor review_overdue is reported.
    watched = replace(facts, first_review_at=NOW - 30 * DAY)
    assert gtd.review_watched(watched) and gtd.review_age_days(watched, NOW) == 30
    for off in (replace(watched, collect_enabled=False), replace(watched, review_enabled=False)):
        assert not gtd.review_watched(off) and gtd.review_age_days(off, NOW) is None
    assert gtd.review_age_days(replace(facts, first_review_at=NOW - 3 * DAY), NOW) == 3
    assert gtd.review_age_days(replace(facts, first_review_at=NOW - 30 * DAY, last_review_at=NOW - DAY), NOW) == 1


# ---- schedules -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("13:00", 13 * 3600),
        ("00:00", 0),
        ("23:59", 23 * 3600 + 59 * 60),
        ("off", None),
        ("25:00", 13 * 3600),
        ("1:5", 13 * 3600),
        ("", 13 * 3600),
    ],
)
def test_collect_time(value, expected):
    assert gtd.utc_offset(value) == expected


def test_next_collect_is_today_until_it_passed():
    midnight = NOW - NOW % DAY
    assert gtd.next_collect(midnight + 3600, 13 * 3600) == midnight + 13 * 3600
    assert gtd.next_collect(midnight + 13 * 3600, 13 * 3600) == midnight + DAY + 13 * 3600


@pytest.mark.parametrize(
    ("moment", "week"),
    [
        (datetime(2026, 10, 4, 17, tzinfo=UTC), "2026-W40"),
        (datetime(2027, 1, 3, 17, tzinfo=UTC), "2026-W53"),  # 2026 has 53 ISO weeks
        (datetime(2027, 1, 10, 17, tzinfo=UTC), "2027-W01"),
        (datetime(2026, 12, 27, 23, 59, 59, tzinfo=UTC), "2026-W52"),
    ],
)
def test_iso_weeks_across_the_year_end(moment, week):
    assert gtd.iso_week(int(moment.timestamp())) == week


def test_week_shift_crosses_years():
    assert gtd.week_shift("2027-W01", -1) == "2026-W53"
    assert gtd.week_shift("2026-W53", 1) == "2027-W01"
    assert gtd.week_shift("2026-W40", -12) == "2026-W28"


def at(*args: int) -> int:
    return int(datetime(*args, tzinfo=UTC).timestamp())


def test_the_review_window_is_sunday_17_utc_to_the_end_of_the_iso_week():
    sunday = at(2026, 10, 4, 17)
    assert gtd.review_window(sunday - 1) is None
    assert gtd.review_window(sunday) == (sunday, at(2026, 10, 5))
    assert gtd.review_window(at(2026, 10, 4, 23, 59, 59)) == (sunday, at(2026, 10, 5))
    assert gtd.review_window(at(2026, 10, 5)) is None  # Monday: a new ISO week
    assert gtd.next_review(sunday - 1) == sunday
    assert gtd.next_review(sunday) == sunday + 7 * DAY
    assert gtd.next_review(at(2026, 10, 7, 9)) == sunday + 7 * DAY


def test_the_review_stays_at_17_utc_across_the_us_dst_change():
    # 2026-11-01: US daylight time ends that morning; the review is still 17:00 UTC (09:00 PST).
    assert gtd.next_review(at(2026, 10, 30)) == at(2026, 11, 1, 17)
    assert gtd.review_window(at(2026, 11, 1, 17)) == (at(2026, 11, 1, 17), at(2026, 11, 2))
    assert gtd.iso_week(at(2026, 11, 1, 17)) == "2026-W44"


# ---- carryover and review text -------------------------------------------------------------


def test_carried_lines_say_how_many_days_ago():
    assert gtd.carried_line("缴费", NOW, NOW - DAY - 5) == "[1 天前] 缴费"
    assert gtd.carried_line("缴费", NOW, NOW - 13 * DAY) == "[13 天前] 缴费"
    assert gtd.carried_line("缴费", NOW, NOW - 3600) == "[1 天前] 缴费"  # never "0 days"
    # A long stored summary (up to 64 KiB) is cut on a UTF-8 boundary.
    long = gtd.carried_line("缴" * 2000, NOW, NOW - 2 * DAY)
    assert long.startswith("[2 天前] 缴") and len(long.encode()) <= gtd.CARRYOVER_LINE_BYTES + len("[2 天前] ".encode())
    long.encode().decode()


def test_the_last_collect_is_today_s_slot_once_it_passed_else_yesterday_s():
    midnight = NOW - NOW % DAY
    offset = 13 * 3600
    assert gtd.last_collect(midnight + offset, offset) == midnight + offset
    assert gtd.last_collect(midnight + offset + 1800, offset) == midnight + offset
    assert gtd.last_collect(midnight + offset - 1, offset) == midnight + offset - DAY


def candidates(now: int, per_day: dict[int, int]) -> list[dict[str, object]]:
    """``per_day`` maps "N 天前" to how many open mail tasks arrived that day."""
    rows = []
    for days, count in per_day.items():
        for index in range(count):
            rows.append({"event_id": f"d{days}-{index}", "created_at": now - days * DAY - 60 * (index + 1)})
    return rows


def test_the_carryover_is_spread_over_the_days_oldest_day_first():
    # A normal week: 40 open tasks from yesterday, 5 from 2 days ago, 2 each from 9 and 13 days ago.
    picked = gtd.pick_carried(candidates(NOW, {1: 40, 2: 5, 9: 2, 13: 2}), NOW)
    assert len(picked) == gtd.CARRYOVER_MAX_ROWS
    days = {day: sum(event.startswith(f"d{day}-") for event in picked) for day in (1, 2, 9, 13)}
    # Every older task is carried; yesterday's fill the rest, newest first.
    assert days == {1: 21, 2: 5, 9: 2, 13: 2}
    assert picked[:4] == ["d13-0", "d9-0", "d2-0", "d1-0"]
    assert [event for event in picked if event.startswith("d1-")] == [f"d1-{index}" for index in range(21)]
    # More days than slots in a round: the oldest days go first.
    many = gtd.pick_carried(candidates(NOW, {day: 5 for day in range(1, 14)}), NOW, cap=15)
    assert sorted({int(event[1:].split("-")[0]) for event in many[:13]}) == list(range(1, 14))
    assert many[13:] == ["d13-1", "d12-1"]
    assert gtd.pick_carried([], NOW) == []


def test_carried_lines_keep_the_pick_order_until_the_byte_cap_then_newest_first():
    rows = [
        {"event_id": "old", "summary": "旧", "created_at": NOW - 9 * DAY},
        {"event_id": "new", "summary": "新", "created_at": NOW - DAY - 60},
    ]
    assert gtd.carried_lines(rows, ["old", "new", "gone"], NOW) == ["[1 天前] 新", "[9 天前] 旧"]
    big = [{"event_id": f"e{i}", "summary": "长" * 400, "created_at": NOW - (2 + i) * DAY} for i in range(30)]
    lines = gtd.carried_lines(big, [f"e{i}" for i in range(30)], NOW)
    assert sum(len(line.encode()) + 1 for line in lines) <= gtd.CARRYOVER_MAX_BYTES
    # The cap keeps the first picks in pick order (e0, e1, ...), shown newest first.
    assert 0 < len(lines) < 30
    assert lines[0].startswith("[2 天前]") and lines[-1].startswith(f"[{1 + len(lines)} 天前]")


def daily(**fields: object) -> gtd.Daily:
    base = gtd.Daily(23, 12, 5, 4, 2, 41, 3, 40, 35, 42, "api", 6, 9, True)
    return replace(base, **fields)


def ops_digest() -> OpsDigest:
    item = DigestItem("mail-hero", "parse_failed", "warning", NOW - 3600, (("count", 1),))
    return OpsDigest(NOW - 13 * 3600, (item,), "https://home.ziyixi.science/")


def test_the_review_body_is_counts_trends_and_links():
    facts = gtd.ReviewFacts(
        week="2026-W40",
        snapshot_day="2026-10-04",
        all=daily(open=57, overdue=3, undated=40),
        inbox=daily(),
        all_week_ago=daily(open=57),
        inbox_week_ago=daily(open=31),
        attention_events=0,
        ops=ops_digest(),
        last_review_at=NOW - 7 * DAY,
        public_host="todofy.example",
        dashboard_url="https://home.ziyixi.science/",
    )
    body = gtd.review_body(facts, NOW + 4 * 3600)
    assert body == (
        "快照 2026-10-04（Todoist 元数据，只含计数）\n"
        "收件箱：开放 23（上周 31，-8）；最老 41 天（上周 41，持平）；"
        "0–7 天 12 · 8–14 天 5 · 15–30 天 4 · >30 天 2\n"
        "全部项目：开放 57（上周 57，持平） · 逾期 3（上周 3，持平） · 无日期 40（上周 40，持平）\n"
        "近 7 天：新建 35 · 完成 42（上周 42，持平）\n"
        "邮件任务：1–14 天前收到、仍开着 9（晨报最多带入 30 条）\n"
        "Todofy：需处理事件 0；运维：（仪表盘报告 2026-10-04 00:00 UTC）mail-hero parse_failed count=1\n"
        "上次回顾：2026-09-27 完成（7 天前）\n"
        "本周重点：收件箱里超过 30 天的 2 项：逐个决定 做 / 委派 / 删除\n"
        "步骤：清空收件箱 → 看逾期与无日期 → 看项目与等待 → 想想下周\n"
        "面板：https://home.ziyixi.science/   Todofy GTD：https://todofy.example/gtd\n"
    )
    # Week-over-week changes, what stands out, and title-free links to the oldest inbox tasks.
    moved = replace(
        facts,
        all=daily(open=60, overdue=7, undated=38, completed_7d=30),
        inbox=daily(age_31_plus=0, oldest_days=20, open=35),
        all_week_ago=daily(open=57, overdue=3, undated=40, completed_7d=42),
        inbox_week_ago=daily(open=31, oldest_days=41),
        oldest_inbox=("6XR4GqQQCW6Gv9h4", "bad id/../x", "abc_123-Z"),
    )
    text = gtd.review_body(moved, NOW + 4 * 3600)
    assert "最老 20 天（上周 41，-21）" in text
    assert "开放 60（上周 57，+3） · 逾期 7（上周 3，+4） · 无日期 38（上周 40，-2）" in text
    assert "完成 30（上周 42，-12）" in text
    assert "本周重点：逾期比上周多 4 项：重排日期，或删掉不再做的\n本周重点：收件箱比上周多 4 项：先清空到 0\n" in text
    assert (
        "收件箱最老的任务：https://app.todoist.com/app/task/6XR4GqQQCW6Gv9h4"
        "  https://app.todoist.com/app/task/abc_123-Z\n"
    ) in text
    assert "bad id" not in text
    assert gtd.review_title("2026-W40") == "每周回顾 2026-W40"


def test_a_review_without_a_snapshot_or_completions_says_so():
    facts = gtd.ReviewFacts("2026-W40", None, None, None, None, None, None, None, None, "", None)
    body = gtd.review_body(facts, NOW)
    assert body.startswith("快照：本周没有可用的 Todoist 快照")
    assert "需处理事件 不可用；运维：无" in body and "上次回顾：尚无完成记录" in body
    assert "http" not in body
    unknown = gtd.ReviewFacts(
        "2026-W40",
        "2026-10-04",
        daily(created_7d=None, completed_7d=None, mail_open=None, complete=False),
        None,
        None,
        None,
        2,
        None,
        None,
        "t.example",
        None,
    )
    text = gtd.review_body(unknown, NOW)
    assert "任务过多，快照不完整" in text and "近 7 天：新建 不可用 · 完成 不可用" in text
    assert "收件箱：" not in text and "邮件任务" not in text and "上周" not in text
    assert len(text.encode()) <= gtd.MAX_REVIEW_BODY_BYTES


def row(day: str, scope: str, **fields: object) -> dict[str, object]:
    value = {name: getattr(daily(), name) for name in gtd.Daily.__dataclass_fields__}
    return value | {"day": day, "scope": scope, "complete": 1, **fields}


def test_pick_days_takes_the_newest_day_and_the_one_a_week_before():
    rows = [
        row("2026-09-27", "all", open=50),
        row("2026-09-27", "inbox", open=31),
        row("2026-10-03", "all", open=60),
        row("2026-10-04", "all", open=57),
        row("2026-10-04", "inbox", open=23),
        row("2026-10-05", "all", open=1),  # after today: ignored
    ]
    picked = gtd.pick_days(rows, "2026-10-04")
    assert picked["day"] == "2026-10-04"
    assert (picked["all"].open, picked["inbox"].open) == (57, 23)
    assert (picked["all_week_ago"].open, picked["inbox_week_ago"].open) == (50, 31)
    assert gtd.pick_days([], "2026-10-04")["day"] is None


def test_the_api_series_has_every_day_oldest_first():
    series = gtd.daily_api([row("2026-10-03", "all", complete=0), row("2026-10-03", "inbox")], "2026-10-02", 3)
    assert [(day["day"], day["recorded"]) for day in series] == [
        ("2026-10-02", False),
        ("2026-10-03", True),
        ("2026-10-04", False),
    ]
    assert series[1]["all"]["complete"] is False and series[1]["inbox"]["open"] == 23
    assert series[0]["all"] is None and series[0]["inbox"] is None
