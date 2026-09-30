"""runtime/gtd.py in real workerd (D1, a real object storage) against the Todoist fake: the daily
read-only snapshot across alarms, its aggregates, failures and fallbacks, the shed guard, the Sunday
review (exactly once per ISO week), review completion, retention and a privacy sweep. Synthetic tasks
only; their titles and descriptions are sentinels that must never leave Todoist's answers.

The probe (tests/runtime/reports_probe) runs the module with any ``now``; test_gtd_alarm.py covers the
coordinator's alarm loop."""

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.fakes.server import Reply
from tests.fakes.todoist_fake import COMPLETED_PATH, PROJECT_ID, TASKS_PATH, stamp
from tests.runtime.reports_support import (  # noqa: F401
    NOW,
    PUBLIC_HOST,
    Probe,
    clean_fixture,
    component_errors,
    probe_fixture,
)
from todofy.core import gtd
from todofy.core.request_id import todoist_request_id

DAY = 86_400
HOUR = 3_600
TODAY = gtd.day_of(NOW)  # Monday 2026-09-28, 15:00 UTC
YESTERDAY = gtd.shift(TODAY, -1)
TOMORROW_COLLECT = NOW - NOW % DAY + DAY + 13 * HOUR
SUNDAY = int(datetime(2026, 10, 4, 17, tzinfo=UTC).timestamp())  # ISO week 2026-W40
SENTINEL = "SENTINEL-标题-5e1f"
SENTINEL_DESC = "SENTINEL-描述-a9c4"
ENABLED = {"GTD_COLLECT_UTC": "13:00", "GTD_REVIEW_ENABLED": "true"}


@pytest.fixture(autouse=True)
def fresh_object(probe: Probe) -> None:
    probe.call("/gtd", op="reset")


def tick(probe: Probe, now: int, *, wait: int | None = None, state: dict | None = None, **overrides: str) -> dict:
    return probe.call("/gtd", op="tick", now=now, wait=wait, state=state, vars=ENABLED | overrides)


def only_review(now: int) -> dict[str, int]:
    """Object state that makes only the review due (the snapshot is not)."""
    return {"next_collect": now + 30 * DAY, "next_review": 0}


def gets(probe: Probe) -> list[Any]:
    return probe.todoist.received("GET")


def seed(probe: Probe, content: str = SENTINEL, **fields: Any) -> Any:
    return probe.todoist.add_task(content, SENTINEL_DESC, **fields)


# ---- the snapshot ----------------------------------------------------------------------------


def test_a_snapshot_spans_alarms_with_at_most_five_gets_each(probe):
    probe.todoist.max_page_size = 2
    tasks = [seed(probe, project_id=PROJECT_ID if n % 2 else "work") for n in range(13)]

    first = tick(probe, NOW)
    assert len(probe.todoist.lists()) == 5 and probe.todoist.completed_lists() == []
    assert (first["state"]["phase"], first["state"]["pages"], first["next_at"]) == ("tasks", 5, NOW + 1)
    assert probe.sql("SELECT status FROM gtd_snapshots") == [{"status": "collecting"}]

    second = tick(probe, NOW + 1)
    assert len(probe.todoist.lists()) == 7 and len(probe.todoist.completed_lists()) == 1
    assert second["state"]["phase"] == "idle" and second["state"]["next_collect"] == TOMORROW_COLLECT
    counts = [call for call in first["calls"] + second["calls"] if call[0] == "count"]
    assert counts == [["count", 1, NOW]] * 5 + [["count", 1, NOW + 1]] * 3

    [snapshot] = probe.sql("SELECT status, task_count, skipped, pages, error_code FROM gtd_snapshots")
    assert snapshot == {"status": "ok", "task_count": 13, "skipped": 0, "pages": 7, "error_code": ""}
    stored = probe.sql("SELECT task_id FROM gtd_snapshot_tasks WHERE day = ? ORDER BY task_id", TODAY)
    assert [row["task_id"] for row in stored] == sorted(task.id for task in tasks)
    # Every project (no project filter), the maximum page size, the cursor carried across alarms.
    listed = probe.todoist.lists()
    assert all(request.param("project_id") is None and request.param("limit") == "200" for request in listed)
    assert [request.param("cursor") for request in listed][:2] == [None, "fake-cursor-2"]
    [completed] = probe.todoist.completed_lists()
    assert (completed.param("since"), completed.param("until")) == (gtd.rfc3339(NOW - 7 * DAY), gtd.rfc3339(NOW))
    assert all(request.headers["authorization"] == "Bearer fake-todoist-token" for request in gets(probe))


def test_more_than_ten_pages_is_a_partial_snapshot_without_counters(probe):
    probe.todoist.max_page_size = 2
    for _ in range(21):
        seed(probe)
    tick(probe, NOW)
    tick(probe, NOW + 1)
    last = tick(probe, NOW + 2)
    assert len(probe.todoist.lists()) == 10
    [snapshot] = probe.sql("SELECT status, task_count, pages, error_code FROM gtd_snapshots")
    assert snapshot == {"status": "partial", "task_count": 20, "pages": 10, "error_code": "page_cap"}
    assert [row["complete"] for row in probe.sql("SELECT complete FROM gtd_daily")] == [0, 0]
    assert last["facts"]["counters"] == {} and last["facts"]["last_ok_at"] is None
    assert last["state"]["next_collect"] == TOMORROW_COLLECT


def test_the_aggregates_count_ages_dues_scopes_completions_and_closed_tasks(probe):
    def added(days: float) -> str:
        return stamp(NOW - days * DAY)

    a = seed(probe, added_at=added(1), due={"date": YESTERDAY}, labels=["waiting"])
    b = seed(probe, added_at=added(10))
    c = seed(probe, added_at=added(20), due={"date": f"{TODAY}T10:00:00Z", "timezone": "America/New_York"})
    seed(probe, added_at=added(40), due={"date": gtd.shift(TODAY, 2)})
    seed(probe, project_id="work", due={"date": f"{YESTERDAY}T09:00:00", "is_recurring": True})
    seed(probe, project_id="work", added_at=added(2), deadline={"date": TODAY})
    x = seed(probe, added_at=added(3))
    y = seed(probe, project_id="work", added_at=added(30))
    z = seed(probe, project_id="work")
    probe.todoist.complete(x.id, NOW - DAY)
    probe.todoist.complete(y.id, NOW - 2 * DAY)
    probe.todoist.complete(z.id, NOW - 8 * DAY)  # outside the 7-day window
    # Yesterday's ok snapshot held a, b and a task that is gone now.
    probe.insert("gtd_snapshots", day=YESTERDAY, status="ok", task_count=3, started_at=NOW - DAY, finished_at=NOW - DAY)
    for task_id in (a.id, b.id, "gone-1"):
        probe.insert(
            "gtd_snapshot_tasks", day=YESTERDAY, task_id=task_id, project_id="p", priority=1, content_hmac="0" * 64
        )
    # Mail tasks of the last 14 days: a and b are still open, x was completed.
    for event_id, created_at, task_id in (
        ("m-a", NOW - 2 * DAY, a.id),
        ("m-b", NOW - HOUR, b.id),
        ("m-x", NOW - 3 * DAY, x.id),
    ):
        probe.insert(
            "summaries",
            event_id=event_id,
            created_at=created_at,
            subject="s",
            summary="摘要",
            model="m",
            task_id=task_id,
        )

    result = tick(probe, NOW)

    rows = {row["scope"]: row for row in probe.sql("SELECT * FROM gtd_daily WHERE day = ?", TODAY)}
    common = {"day": TODAY, "completed_source": "api", "complete": 1, "computed_at": NOW}
    assert rows["all"] == common | {
        "scope": "all",
        "open": 6,
        "age_0_7": 2,
        "age_8_14": 1,
        "age_15_30": 1,
        "age_31_plus": 1,
        "oldest_days": 40,
        "overdue": 3,
        "undated": 2,
        "created_7d": 3,
        "completed_7d": 2,
        "closed_1d": 1,
        "mail_open": 2,
    }
    assert rows["inbox"] == common | {
        "scope": "inbox",
        "open": 4,
        "age_0_7": 1,
        "age_8_14": 1,
        "age_15_30": 1,
        "age_31_plus": 1,
        "oldest_days": 40,
        "overdue": 2,
        "undated": 1,
        "created_7d": 2,
        "completed_7d": 1,
        "closed_1d": None,
        "mail_open": None,
    }
    assert result["facts"]["counters"] == {
        "inbox_open": 4,
        "inbox_oldest_days": 40,
        "overdue": 3,
        "carryover_open": 2,
        "completed_7d": 2,
    }
    assert result["facts"]["last_ok_at"] == NOW and result["facts"]["snapshot_age"] is None
    [row] = probe.sql("SELECT labels, due_at, due_recurring FROM gtd_snapshot_tasks WHERE task_id = ?", c.id)
    assert row == {
        "labels": "[]",
        "due_at": int(datetime.fromisoformat(f"{TODAY}T10:00:00+00:00").timestamp()),
        "due_recurring": 0,
    }


def test_without_an_inbox_project_only_the_all_scope_is_written(probe):
    seed(probe)
    result = tick(probe, NOW, TODOIST_DEFAULT_PROJECT_ID="")
    assert [row["scope"] for row in probe.sql("SELECT scope FROM gtd_daily")] == ["all"]
    assert "inbox_open" not in result["facts"]["counters"]


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (Reply(503, {"error": "busy"}), "todoist_unavailable"),
        (Reply(429, {"error": "slow down"}, {"retry-after": "1200"}), "todoist_rate_limited"),
        (Reply(200, {"unexpected": True}), "malformed_page"),
        (Reply(hang=True), "todoist_unavailable"),
    ],
    ids=["503", "429", "malformed", "timeout"],
)
def test_a_failed_list_is_retried_at_most_three_times_a_day(probe, reply, code):
    seed(probe)
    for _ in range(3):
        probe.todoist.queue("GET", TASKS_PATH, reply)
    retry = 1200 if "retry-after" in reply.headers else 600
    fast = {"GTD_PAGE_TIMEOUT_MS": "1000"}
    first = tick(probe, NOW, **fast)
    assert first["state"]["next_collect"] == NOW + retry and first["state"]["attempts"] == 1
    [snapshot] = probe.sql("SELECT status, error_code FROM gtd_snapshots")
    assert snapshot == {"status": "failed", "error_code": code}
    assert probe.sql("SELECT count(*) AS n FROM gtd_daily") == [{"n": 0}]
    assert first["facts"]["counters"] == {} and ["step", "gtd", "failed", code] in first["calls"]
    tick(probe, NOW + retry, **fast)
    third = tick(probe, NOW + 2 * retry, **fast)
    assert third["state"]["attempts"] == 3 and third["state"]["next_collect"] == TOMORROW_COLLECT
    assert len(probe.todoist.lists()) == 3
    # Tomorrow starts over.
    tomorrow = tick(probe, TOMORROW_COLLECT)
    assert tomorrow["state"]["attempts"] == 1 and tomorrow["facts"]["last_ok_at"] == TOMORROW_COLLECT


def test_an_auth_failure_blocks_todoist_for_six_hours(probe):
    probe.todoist.queue("GET", TASKS_PATH, Reply(401, {"error": "Unauthorized"}))
    result = tick(probe, NOW)
    assert ["block", NOW] in result["calls"]
    assert result["state"]["next_collect"] == NOW + 6 * HOUR
    assert probe.sql("SELECT error_code FROM gtd_snapshots") == [{"error_code": "todoist_auth_blocked"}]


@pytest.mark.parametrize(
    ("overrides", "wait", "next_collect"),
    [
        ({"PROCESSING_PAUSED": "true"}, None, NOW + 600),
        ({"FORCE_PAUSE_TODOIST": "true"}, None, NOW + 600),
        ({}, NOW + 5 * HOUR, NOW + 5 * HOUR),  # the auth block (or a full call window)
        ({}, 0, NOW + 600),  # FORCE_PAUSE_TODOIST as the coordinator reports it
        ({"GTD_COLLECT_UTC": "off"}, None, NOW + DAY),
    ],
    ids=["processing_paused", "force_pause_todoist", "blocked", "paused", "off"],
)
def test_switches_and_blocks_make_no_todoist_call(probe, overrides, wait, next_collect):
    seed(probe)
    result = tick(probe, NOW, wait=wait, **overrides)
    assert gets(probe) == [] and probe.sql("SELECT day FROM gtd_snapshots") == []
    assert result["state"]["next_collect"] == next_collect


def test_a_pause_mid_way_resumes_from_the_cursor(probe):
    probe.todoist.max_page_size = 1
    tasks = [seed(probe) for _ in range(7)]
    tick(probe, NOW)
    paused = tick(probe, NOW + 1, PROCESSING_PAUSED="true")
    assert len(probe.todoist.lists()) == 5 and paused["state"]["next_collect"] == NOW + 1 + 600
    assert paused["state"]["phase"] == "tasks" and paused["state"]["cursor"] == "fake-cursor-5"
    tick(probe, NOW + 601)
    assert len(probe.todoist.lists()) == 7
    stored = probe.sql("SELECT task_id FROM gtd_snapshot_tasks ORDER BY task_id")
    assert [row["task_id"] for row in stored] == sorted(task.id for task in tasks)


def test_a_failed_completed_list_keeps_the_snapshot_without_completions(probe):
    seed(probe)
    probe.todoist.queue("GET", COMPLETED_PATH, Reply(500, {"error": "boom"}))
    result = tick(probe, NOW)
    assert probe.sql("SELECT status FROM gtd_snapshots") == [{"status": "ok"}]
    rows = probe.sql("SELECT scope, completed_7d, created_7d, completed_source FROM gtd_daily ORDER BY scope")
    assert rows == [
        {"scope": "all", "completed_7d": None, "created_7d": None, "completed_source": "none"},
        {"scope": "inbox", "completed_7d": None, "created_7d": None, "completed_source": "none"},
    ]
    assert "completed_7d" not in result["facts"]["counters"] and result["facts"]["counters"]["inbox_open"] == 1


def test_an_unfinished_collection_is_given_up_the_next_day(probe):
    probe.todoist.max_page_size = 1
    for _ in range(7):
        seed(probe)
    assert tick(probe, NOW)["state"]["phase"] == "tasks"
    result = tick(probe, TOMORROW_COLLECT)
    days = {row["day"]: row for row in probe.sql("SELECT day, status, error_code FROM gtd_snapshots")}
    assert days[TODAY] == {"day": TODAY, "status": "failed", "error_code": "interrupted"}
    assert days[gtd.day_of(TOMORROW_COLLECT)]["status"] == "collecting"
    assert result["state"]["day"] == gtd.day_of(TOMORROW_COLLECT) and result["state"]["attempts"] == 1


def test_a_rerun_the_same_day_replaces_the_snapshot(probe):
    first, second = seed(probe), seed(probe)
    tick(probe, NOW)
    probe.todoist.complete(first.id, NOW + 60)
    tick(probe, NOW + 120, state={"next_collect": 0, "attempts": 1})
    assert [row["task_id"] for row in probe.sql("SELECT task_id FROM gtd_snapshot_tasks")] == [second.id]
    assert probe.sql("SELECT task_count FROM gtd_snapshots") == [{"task_count": 1}]


def test_a_shed_guard_holds_the_snapshot_within_its_48_hour_bound(probe):
    seed(probe)
    guard = {"level": "shed", "reason": "d1_reads_high", "until": gtd.rfc3339(NOW + 10 * HOUR)}
    probe.call("/gtd", op="guard", now=NOW, guard=guard, ran=NOW - 20 * HOUR)
    held = tick(probe, NOW)
    assert gets(probe) == [] and held["state"]["held"] is True
    assert held["state"]["next_collect"] == NOW + 10 * HOUR
    # Ending the guard makes it due at once (the coordinator's ops_set_guard calls release).
    probe.call("/gtd", op="guard", now=NOW + 60, guard={"level": "normal", "reason": "quota_ok", "until": None})
    released = probe.call("/gtd", op="release", now=NOW + 60)
    assert released["state"]["next_collect"] == NOW + 60 and released["state"]["held"] is False
    ran = tick(probe, NOW + 60)
    assert ran["facts"]["last_ok_at"] == NOW + 60


def test_the_bound_runs_the_snapshot_despite_a_renewed_guard(probe):
    seed(probe)
    guard = {"level": "shed", "reason": "d1_reads_high", "until": gtd.rfc3339(NOW + 10 * HOUR)}
    probe.call("/gtd", op="guard", now=NOW, guard=guard, ran=NOW - 48 * HOUR)
    assert tick(probe, NOW)["facts"]["last_ok_at"] == NOW


# ---- the Sunday review -----------------------------------------------------------------------


def seed_days(probe: Probe, day: str, *, inbox_open: int, all_open: int) -> None:
    for scope, open_count in (("all", all_open), ("inbox", inbox_open)):
        probe.insert(
            "gtd_daily",
            day=day,
            scope=scope,
            open=open_count,
            age_0_7=1,
            age_8_14=1,
            age_15_30=1,
            age_31_plus=1,
            oldest_days=40,
            overdue=2,
            undated=5,
            created_7d=7,
            completed_7d=9,
            completed_source="api",
            closed_1d=1,
            mail_open=3 if scope == "all" else None,
            complete=1,
            computed_at=NOW,
        )


OPS_REPORT = {
    "generated_at": gtd.rfc3339(SUNDAY - 18 * HOUR),
    "dashboard_url": "https://home.ziyixi.science/",
    "items": [
        {
            "source": "mail-hero",
            "code": "parse_failed",
            "severity": "warning",
            "since": gtd.rfc3339(SUNDAY - DAY),
            "metrics": {"count": 1},
        },
        {
            "source": "todofy",
            "code": "backup_active",
            "severity": "info",
            "since": gtd.rfc3339(SUNDAY - DAY),
            "metrics": {},
        },
    ],
}


def review(probe: Probe, now: int, **overrides: str) -> dict:
    return probe.call(
        "/gtd", op="tick", now=now, state=only_review(now), vars=ENABLED | overrides, ops_report=OPS_REPORT
    )


def test_the_review_is_one_task_per_iso_week_with_counts_only(probe):
    seed_days(probe, "2026-10-04", inbox_open=23, all_open=57)
    seed_days(probe, "2026-09-27", inbox_open=31, all_open=57)
    result = review(probe, SUNDAY, TODOIST_REVIEW_PROJECT_ID="review-project")
    [create] = probe.todoist.creates()
    sent = create.json()
    assert sent["content"] == "每周回顾 2026-W40" and sent["project_id"] == "review-project"
    assert create.headers["x-request-id"] == todoist_request_id(
        sent["content"], sent["description"], "todofy-review:2026-W40"
    )
    body = sent["description"]
    assert body.startswith("快照 2026-10-04（Todoist 元数据，只含计数）\n收件箱：开放 23（上周 31，-8）")
    assert "全部项目：开放 57（上周 57，持平） · 逾期 2 · 无日期 5" in body
    assert "近 7 天：新建 7 · 完成 9\n邮件任务：14 天内仍开着 3\n" in body
    assert "Todofy：需处理事件 0；运维：（仪表盘报告 2026-10-03 23:00 UTC）mail-hero parse_failed count=1\n" in body
    assert "backup_active" not in body  # info items are not listed
    assert f"面板：https://home.ziyixi.science/   Todofy GTD：https://{PUBLIC_HOST}/gtd" in body
    [row] = probe.sql("SELECT week, state, project_id, task_id, attempts, subject FROM gtd_reviews")
    assert row == {
        "week": "2026-W40",
        "state": "created",
        "project_id": "review-project",
        "task_id": probe.todoist.tasks[0].id,
        "attempts": 1,
        "subject": "每周回顾 2026-W40",
    }
    assert result["state"]["next_review"] == SUNDAY + 7 * DAY
    assert result["facts"]["first_review_at"] == SUNDAY
    # Later the same evening (a restarted schedule, say): still one task.
    again = review(probe, SUNDAY + 2 * HOUR)
    assert len(probe.todoist.creates()) == 1 and again["state"]["next_review"] == SUNDAY + 7 * DAY


def test_the_review_goes_to_the_default_project_without_a_review_project(probe):
    review(probe, SUNDAY)
    [create] = probe.todoist.creates()
    assert create.json()["project_id"] == PROJECT_ID
    assert create.json()["description"].startswith("快照：本周没有可用的 Todoist 快照")


@pytest.mark.parametrize("status", [400, 401])
def test_a_failed_review_is_retried_hourly_with_its_frozen_request(probe, status):
    for _ in range(5):
        probe.todoist.queue("POST", TASKS_PATH, Reply(status, {"error": "no"}))
    now = SUNDAY
    assert review(probe, now)["state"]["next_review"] == now + HOUR
    seed_days(probe, "2026-10-04", inbox_open=1, all_open=1)  # a later body would differ: it must not be used
    for attempt in range(2, 6):
        now += HOUR
        expected = now + HOUR if attempt < 5 else SUNDAY + 7 * DAY
        assert review(probe, now)["state"]["next_review"] == expected
    creates = probe.todoist.creates()
    assert len(creates) == 5 and len({(create.body, create.headers["x-request-id"]) for create in creates}) == 1
    [row] = probe.sql("SELECT state, attempts, last_error_code FROM gtd_reviews")
    assert row == {"state": "failed", "attempts": 5, "last_error_code": "review_create_failed"}
    review(probe, now + HOUR)
    assert len(probe.todoist.creates()) == 5


def test_failed_retries_stop_when_the_iso_week_ends(probe):
    probe.todoist.queue("POST", TASKS_PATH, Reply(400, {"error": "no"}))
    late = SUNDAY + 6 * HOUR + 30 * 60  # 23:30 UTC
    assert review(probe, late)["state"]["next_review"] == SUNDAY + 7 * DAY


@pytest.mark.parametrize("reply", [Reply(500, {"error": "boom"}), Reply(200, {})], ids=["500", "no_id"])
def test_an_unknown_review_is_never_resent(probe, reply):
    probe.todoist.queue("POST", TASKS_PATH, reply)
    review(probe, SUNDAY)
    assert probe.sql("SELECT state, last_error_code FROM gtd_reviews") == [
        {"state": "unknown", "last_error_code": "review_result_unknown"}
    ]
    review(probe, SUNDAY + HOUR)
    assert len(probe.todoist.creates()) == 1


def test_a_week_left_sending_is_recorded_as_interrupted_and_not_resent(probe):
    probe.insert(
        "gtd_reviews", week="2026-W40", state="sending", subject="t", body="b", created_at=SUNDAY, updated_at=SUNDAY
    )
    review(probe, SUNDAY + 60)
    assert probe.todoist.creates() == []
    assert probe.sql("SELECT state, attempts, last_error_code FROM gtd_reviews") == [
        {"state": "unknown", "attempts": 1, "last_error_code": "interrupted_review_call"}
    ]


@pytest.mark.parametrize(
    ("overrides", "wait"),
    [({"GTD_REVIEW_ENABLED": "false"}, None), ({"FORCE_PAUSE_TODOIST": "true"}, None), ({}, SUNDAY + HOUR)],
    ids=["disabled", "paused", "blocked"],
)
def test_no_review_while_disabled_paused_or_blocked(probe, overrides, wait):
    result = probe.call("/gtd", op="tick", now=SUNDAY, wait=wait, state=only_review(SUNDAY), vars=ENABLED | overrides)
    assert probe.todoist.creates() == [] and probe.sql("SELECT week FROM gtd_reviews") == []
    assert result["state"]["next_review"] == (wait or SUNDAY + 600)


@pytest.mark.parametrize(
    ("moment", "next_review"),
    [
        (SUNDAY - 1, SUNDAY),
        (SUNDAY - 3 * DAY, SUNDAY),
        (SUNDAY + 7 * HOUR, SUNDAY + 7 * DAY),  # Monday 00:00: a new ISO week
    ],
)
def test_the_review_waits_for_sunday_17_utc(probe, moment, next_review):
    assert review(probe, moment)["state"]["next_review"] == next_review
    assert probe.todoist.creates() == []


def test_the_iso_week_crosses_the_year_end(probe):
    new_year = int(datetime(2027, 1, 3, 17, tzinfo=UTC).timestamp())
    review(probe, new_year)
    review(probe, new_year + 7 * DAY)
    assert [row["week"] for row in probe.sql("SELECT week FROM gtd_reviews ORDER BY week")] == ["2026-W53", "2027-W01"]
    assert [create.json()["content"] for create in probe.todoist.creates()] == [
        "每周回顾 2026-W53",
        "每周回顾 2027-W01",
    ]


def test_a_completed_review_is_seen_by_the_next_snapshot(probe):
    review(probe, SUNDAY)
    [task] = probe.todoist.tasks
    probe.todoist.complete(task.id, SUNDAY + 3 * HOUR)
    monday = SUNDAY + 20 * HOUR  # Monday 13:00 UTC
    result = tick(probe, monday, state={"next_collect": 0, "next_review": monday + DAY})
    assert probe.sql("SELECT completed_at FROM gtd_reviews") == [{"completed_at": SUNDAY + 3 * HOUR}]
    assert result["facts"]["last_review_at"] == SUNDAY + 3 * HOUR
    assert result["facts"]["review_age_days"] == 0
    later = probe.call("/gtd", op="facts", now=SUNDAY + 3 * HOUR + 11 * DAY, vars=ENABLED)
    assert later["facts"]["review_age_days"] == 11
    # A deleted review task never counts as done.
    review(probe, SUNDAY + 7 * DAY)
    probe.todoist.delete(probe.todoist.tasks[-1].id)
    tick(probe, SUNDAY + 7 * DAY + 20 * HOUR, state={"next_collect": 0, "next_review": SUNDAY + 14 * DAY})
    rows = probe.sql("SELECT week, completed_at FROM gtd_reviews ORDER BY week")
    assert rows == [{"week": "2026-W40", "completed_at": SUNDAY + 3 * HOUR}, {"week": "2026-W41", "completed_at": None}]


def test_the_owner_api_series(probe):
    seed_days(probe, TODAY, inbox_open=4, all_open=6)
    review(probe, SUNDAY)
    daily = probe.call("/gtd/daily", days=3, now=NOW)["daily"]
    assert component_errors("GtdDaily", daily) == []
    assert [(day["day"], day["recorded"]) for day in daily["days"]] == [
        (gtd.shift(TODAY, -2), False),
        (YESTERDAY, False),
        (TODAY, True),
    ]
    assert daily["days"][-1]["inbox"]["open"] == 4
    assert daily["latest_review"]["week"] == "2026-W40" and daily["latest_review"]["state"] == "created"


# ---- retention and privacy -------------------------------------------------------------------


def test_retention_keeps_14_days_of_rows_and_120_of_aggregates(probe):
    for day in (gtd.shift(TODAY, -15), gtd.shift(TODAY, -14)):
        probe.insert("gtd_snapshot_tasks", day=day, task_id="t", project_id="p", priority=1, content_hmac="0" * 64)
    for day in (gtd.shift(TODAY, -121), gtd.shift(TODAY, -120)):
        seed_days(probe, day, inbox_open=1, all_open=1)
        probe.insert("gtd_snapshots", day=day, status="ok", started_at=NOW, finished_at=NOW)
    for week in ("2025-W30", "2026-W40"):
        probe.insert("gtd_reviews", week=week, state="created", subject="t", body="b", created_at=NOW, updated_at=NOW)
    assert probe.call("/retention/tick", now=NOW)["more"] is False
    assert probe.sql("SELECT DISTINCT day FROM gtd_snapshot_tasks") == [{"day": gtd.shift(TODAY, -14)}]
    assert probe.sql("SELECT DISTINCT day FROM gtd_daily") == [{"day": gtd.shift(TODAY, -120)}]
    assert probe.sql("SELECT day FROM gtd_snapshots") == [{"day": gtd.shift(TODAY, -120)}]
    assert probe.sql("SELECT week FROM gtd_reviews") == [{"week": "2026-W40"}]


def test_no_task_text_is_stored_logged_or_sent(probe):
    """The privacy sweep: sentinel titles and descriptions reach the Worker in every Todoist answer and
    must appear nowhere it writes: D1, the object's state, the review task, the API, the log."""
    probe.todoist.max_page_size = 2
    for n in range(5):
        seed(probe, f"{SENTINEL}-{n}", labels=["家"], project_id=PROJECT_ID if n % 2 else "work")
    done = seed(probe, f"{SENTINEL}-done", added_at=stamp(NOW - DAY))
    probe.todoist.complete(done.id, NOW - HOUR)
    for event_id, task in (("m1", probe.todoist.tasks[0]), ("m2", probe.todoist.tasks[1])):
        probe.insert(
            "summaries",
            event_id=event_id,
            created_at=NOW - 2 * DAY,
            subject="s",
            summary="合成摘要",
            model="m",
            task_id=task.id,
        )
    states = [tick(probe, NOW), tick(probe, NOW + 1)]
    sunday = review(probe, SUNDAY)
    tables = [
        row["name"]
        for row in probe.sql(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
            " AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    dump = json.dumps({table: probe.sql(f"SELECT * FROM {table}") for table in tables}, ensure_ascii=False)
    written = [
        dump,
        json.dumps([*states, sunday], ensure_ascii=False),
        json.dumps([create.json() for create in probe.todoist.creates()], ensure_ascii=False),
        json.dumps(probe.call("/gtd/daily", days=7, now=NOW), ensure_ascii=False),
        (probe.worker.persist_to / "dev.log").read_text(errors="replace"),
    ]
    assert probe.sql("SELECT count(*) AS n FROM gtd_snapshot_tasks") == [{"n": 5}]
    for text in written:
        assert "SENTINEL" not in text
        assert SENTINEL_DESC not in text
