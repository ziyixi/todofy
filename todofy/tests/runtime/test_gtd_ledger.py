"""runtime/gtd.py in real workerd (D1, a real object storage) against the real Tasks Worker: the daily
read-only snapshot across alarms, its aggregates, failures and fallbacks, the shed guard, the Sunday
review (exactly once per ISO week), review completion, retention and a privacy sweep. Synthetic tasks
only, written straight into Tasks' D1; their titles and descriptions are sentinels that must never leave
Tasks' answers.

The probe (tests/runtime/reports_probe) runs the module with any ``now``; test_gtd_alarm.py covers the
coordinator's alarm loop."""

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from tests.runtime import tasks_support as tasks
from tests.runtime.reports_support import (  # noqa: F401
    NOW,
    PUBLIC_HOST,
    Probe,
    clean_fixture,
    idl_errors,
    probe_fixture,
)
from todofy.core import gtd
from todofy.core.request_id import todoist_request_id
from todofy.runtime.native_tasks import request_id

DAY = 86_400
HOUR = 3_600
TODAY = gtd.day_of(NOW)  # Monday 2026-09-28, 15:00 UTC
YESTERDAY = gtd.shift(TODAY, -1)
TOMORROW_COLLECT = NOW - NOW % DAY + DAY + 13 * HOUR
SUNDAY = int(datetime(2026, 10, 4, 17, tzinfo=UTC).timestamp())  # ISO week 2026-W40
SENTINEL = "SENTINEL-标题-5e1f"
SENTINEL_DESC = "SENTINEL-描述-a9c4"
ENABLED = {"GTD_COLLECT_UTC": "13:00", "GTD_REVIEW_ENABLED": "true"}
TASKS_ORIGIN = "https://tasks.example.test"


@pytest.fixture(autouse=True)
def fresh_object(probe: Probe) -> None:
    probe.call("/gtd", op="reset")


def tick(probe: Probe, now: int, *, state: dict | None = None, fail: tuple[str, ...] = (), **overrides: str) -> dict:
    return probe.call("/gtd", op="tick", now=now, state=state, fail_tasks=list(fail), vars=ENABLED | overrides)


def only_review(now: int) -> dict[str, int]:
    """Object state that makes only the review due (the snapshot is not)."""
    return {"next_collect": now + 30 * DAY, "next_review": 0}


def seed(probe: Probe, *rows: dict[str, Any]) -> list[str]:
    """Sentinel tasks in Tasks' D1 (tasks_support.seed); their IDs."""
    sentinel = {"title": SENTINEL, "description": SENTINEL_DESC}
    return tasks.seed(probe.worker, *(sentinel | row for row in rows), now=NOW)


def bulk(probe: Probe, count: int) -> None:
    """``count`` undated Inbox tasks in one statement."""
    probe.worker.tasks_d1(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < "
        f"{count}) INSERT INTO tasks (id, title, description, created_at, updated_at)"
        f" SELECT printf('bulk-%05d', i), {tasks.text(SENTINEL)}, {tasks.text(SENTINEL_DESC)}, 1, 1 FROM n"
    )


def complete(probe: Probe, task_id: str, at: int) -> None:
    tasks.complete(probe.worker, task_id, at)


def steps(result: dict) -> list[list[Any]]:
    return [call for call in result["calls"] if call[0] == "step"]


# ---- the snapshot ----------------------------------------------------------------------------


def test_a_snapshot_spans_alarms_with_at_most_five_reads_each(probe):
    bulk(probe, 650)
    first = tick(probe, NOW)
    assert (first["state"]["phase"], first["state"]["pages"], first["next_at"]) == ("tasks", 5, NOW + 1)
    assert len(steps(first)) == 5
    assert probe.sql("SELECT status FROM gtd_snapshots") == [{"status": "collecting"}]

    second = tick(probe, NOW + 1)
    assert second["state"]["phase"] == "idle" and second["state"]["next_collect"] == TOMORROW_COLLECT
    assert len(steps(second)) == 3  # the last two task pages and the completions
    [snapshot] = probe.sql("SELECT status, task_count, skipped, pages, error_code FROM gtd_snapshots")
    assert snapshot == {"status": "ok", "task_count": 650, "skipped": 0, "pages": 7, "error_code": ""}
    stored = probe.sql("SELECT count(DISTINCT task_id) AS n FROM gtd_snapshot_tasks WHERE day = ?", TODAY)
    assert stored == [{"n": 650}]


def test_more_than_twenty_pages_is_a_partial_snapshot_without_counters(probe):
    bulk(probe, 2050)
    for second in range(5):  # four of five pages each, then the completions
        last = tick(probe, NOW + second)
    [snapshot] = probe.sql("SELECT status, task_count, pages, error_code FROM gtd_snapshots")
    assert snapshot == {"status": "partial", "task_count": 2000, "pages": 20, "error_code": "page_cap"}
    assert [row["complete"] for row in probe.sql("SELECT complete FROM gtd_daily")] == [0, 0]
    assert last["facts"]["counters"] == {} and last["facts"]["last_ok_at"] is None
    assert last["state"]["next_collect"] == TOMORROW_COLLECT


def test_the_aggregates_count_ages_dues_scopes_completions_and_closed_tasks(probe):
    a, b, c, _, _, _, x, y, z = seed(
        probe,
        {"added": NOW - DAY, "due_date": YESTERDAY, "labels": ["errand"]},
        {"added": NOW - 10 * DAY},
        {
            "added": NOW - 20 * DAY,
            "due_date": TODAY,
            "due_datetime": f"{TODAY}T10:00:00Z",
            "due_timezone": "America/New_York",
        },
        {"added": NOW - 40 * DAY, "due_date": gtd.shift(TODAY, 2)},
        {"project": "work", "due_date": YESTERDAY, "recurrence": "every day"},
        {"project": "work", "added": NOW - 2 * DAY, "deadline": TODAY},
        {"added": NOW - 3 * DAY},
        {"project": "work", "added": NOW - 30 * DAY},
        {"project": "work"},
    )
    complete(probe, x, NOW - DAY)
    complete(probe, y, NOW - 2 * DAY)
    complete(probe, z, NOW - 8 * DAY)  # outside the 7-day window
    # Yesterday's ok snapshot held a, b and a task that is gone now.
    probe.insert("gtd_snapshots", day=YESTERDAY, status="ok", task_count=3, started_at=NOW - DAY, finished_at=NOW - DAY)
    for task_id in (a, b, "gone-1"):
        probe.insert(
            "gtd_snapshot_tasks", day=YESTERDAY, task_id=task_id, project_id="p", priority=1, content_hmac="0" * 64
        )
    # Mail of the last 14 days still pending in Mail: m-a; m-b arrived in the last 24 h, so it is not in the
    # carryover pool, and m-x was converted.
    for event_id, created_at, task_id, triaged_at in (
        ("m-a", NOW - 2 * DAY, "", None),
        ("m-b", NOW - HOUR, "", None),
        ("m-x", NOW - 3 * DAY, x, NOW - 3 * DAY),
    ):
        probe.insert(
            "summaries",
            event_id=event_id,
            created_at=created_at,
            subject="s",
            summary="摘要",
            model="m",
            task_id=task_id,
            triaged_at=triaged_at,
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
        "age_31_plus": 2,
        "oldest_days": 400,
        "overdue": 3,
        "undated": 2,
        "created_7d": 3,
        "completed_7d": 2,
        "closed_1d": 1,
        "mail_open": 1,
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
        "carryover_open": 1,
        "completed_7d": 2,
    }
    assert result["facts"]["last_ok_at"] == NOW and result["facts"]["snapshot_age"] is None
    [row] = probe.sql("SELECT labels, due_at, due_recurring FROM gtd_snapshot_tasks WHERE task_id = ?", c)
    assert row == {
        "labels": "[]",
        "due_at": int(datetime.fromisoformat(f"{TODAY}T10:00:00+00:00").timestamp()),
        "due_recurring": 0,
    }
    [labelled] = probe.sql("SELECT labels FROM gtd_snapshot_tasks WHERE day = ? AND task_id = ?", TODAY, a)
    assert labelled == {"labels": '["errand"]'}


def test_a_failed_list_is_retried_at_most_three_times_a_day(probe):
    seed(probe, {})
    first = tick(probe, NOW, fail=("ListTasks",))
    assert first["state"]["next_collect"] == NOW + 600 and first["state"]["attempts"] == 1
    [snapshot] = probe.sql("SELECT status, error_code FROM gtd_snapshots")
    assert snapshot == {"status": "failed", "error_code": "todoist_unavailable"}
    assert probe.sql("SELECT count(*) AS n FROM gtd_daily") == [{"n": 0}]
    assert first["facts"]["counters"] == {} and ["step", "gtd", "failed", "todoist_unavailable"] in first["calls"]
    tick(probe, NOW + 600, fail=("ListTasks",))
    third = tick(probe, NOW + 1200, fail=("ListTasks",))
    assert third["state"]["attempts"] == 3 and third["state"]["next_collect"] == TOMORROW_COLLECT
    # Tomorrow starts over.
    tomorrow = tick(probe, TOMORROW_COLLECT)
    assert tomorrow["state"]["attempts"] == 1 and tomorrow["facts"]["last_ok_at"] == TOMORROW_COLLECT


@pytest.mark.parametrize(
    ("overrides", "next_collect"),
    [
        ({"PROCESSING_PAUSED": "true"}, NOW + 600),
        ({"FORCE_PAUSE_TODOIST": "true"}, NOW + 600),
        ({"GTD_COLLECT_UTC": "off"}, NOW + DAY),
    ],
    ids=["processing_paused", "force_pause_todoist", "off"],
)
def test_the_switches_read_nothing_from_tasks(probe, overrides, next_collect):
    seed(probe, {})
    result = tick(probe, NOW, **overrides)
    assert steps(result) == [] and probe.sql("SELECT day FROM gtd_snapshots") == []
    assert result["state"]["next_collect"] == next_collect


def test_a_pause_mid_way_resumes_from_the_cursor(probe):
    bulk(probe, 650)
    tick(probe, NOW)
    paused = tick(probe, NOW + 1, PROCESSING_PAUSED="true")
    assert paused["state"]["next_collect"] == NOW + 1 + 600 and steps(paused) == []
    assert paused["state"]["phase"] == "tasks" and paused["state"]["pages"] == 5 and paused["state"]["cursor"]
    resumed = tick(probe, NOW + 601)
    assert resumed["state"]["pages"] == 7 and resumed["state"]["phase"] == "idle"
    assert probe.sql("SELECT count(DISTINCT task_id) AS n FROM gtd_snapshot_tasks") == [{"n": 650}]


def test_a_failed_completion_read_keeps_the_snapshot_without_completions(probe):
    seed(probe, {})
    result = tick(probe, NOW, fail=("ListCompletions",))
    assert result["state"]["next_collect"] == TOMORROW_COLLECT
    assert probe.sql("SELECT status FROM gtd_snapshots") == [{"status": "ok"}]
    rows = probe.sql("SELECT scope, completed_7d, created_7d, completed_source FROM gtd_daily ORDER BY scope")
    assert rows == [
        {"scope": "all", "completed_7d": None, "created_7d": None, "completed_source": "none"},
        {"scope": "inbox", "completed_7d": None, "created_7d": None, "completed_source": "none"},
    ]
    assert "completed_7d" not in result["facts"]["counters"] and result["facts"]["counters"]["inbox_open"] == 1


def test_an_unfinished_collection_is_given_up_the_next_day(probe):
    bulk(probe, 650)
    assert tick(probe, NOW)["state"]["phase"] == "tasks"
    result = tick(probe, TOMORROW_COLLECT)
    days = {row["day"]: row for row in probe.sql("SELECT day, status, error_code FROM gtd_snapshots")}
    assert days[TODAY] == {"day": TODAY, "status": "failed", "error_code": "interrupted"}
    assert days[gtd.day_of(TOMORROW_COLLECT)]["status"] == "collecting"
    assert result["state"]["day"] == gtd.day_of(TOMORROW_COLLECT) and result["state"]["attempts"] == 1


def test_a_rerun_the_same_day_replaces_the_snapshot(probe):
    first, second = seed(probe, {}, {})
    tick(probe, NOW)
    complete(probe, first, NOW + 60)
    tick(probe, NOW + 120, state={"next_collect": 0, "attempts": 1})
    assert [row["task_id"] for row in probe.sql("SELECT task_id FROM gtd_snapshot_tasks")] == [second]
    assert probe.sql("SELECT task_count FROM gtd_snapshots") == [{"task_count": 1}]


def test_a_shed_guard_holds_the_snapshot_within_its_48_hour_bound(probe):
    seed(probe, {})
    guard = {"level": "shed", "reason": "d1_reads_high", "until": gtd.rfc3339(NOW + 10 * HOUR)}
    probe.call("/gtd", op="guard", now=NOW, guard=guard, ran=NOW - 20 * HOUR)
    held = tick(probe, NOW)
    assert steps(held) == [] and held["state"]["held"] is True
    assert held["state"]["next_collect"] == NOW + 10 * HOUR
    # Ending the guard makes it due at once (the coordinator's ops_set_guard calls release).
    probe.call("/gtd", op="guard", now=NOW + 60, guard={"level": "normal", "reason": "quota_ok", "until": None})
    released = probe.call("/gtd", op="release", now=NOW + 60)
    assert released["state"]["next_collect"] == NOW + 60 and released["state"]["held"] is False
    ran = tick(probe, NOW + 60)
    assert ran["facts"]["last_ok_at"] == NOW + 60


def test_the_bound_runs_the_snapshot_despite_a_renewed_guard(probe):
    seed(probe, {})
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
# A project Tasks does not have: a review into it is refused (400), and nothing is created.
MISSING = {"TODOIST_REVIEW_PROJECT_ID": "review-project"}


def review(probe: Probe, now: int, **overrides: str) -> dict:
    return probe.call(
        "/gtd", op="tick", now=now, state=only_review(now), vars=ENABLED | overrides, ops_report=OPS_REPORT
    )


def test_the_review_is_one_task_per_iso_week_with_counts_only(probe):
    seed_days(probe, "2026-10-04", inbox_open=23, all_open=57)
    seed_days(probe, "2026-09-27", inbox_open=31, all_open=57)
    for task_id, project, added in (
        ("old-2", "", SUNDAY - 50 * DAY),
        ("old-1", "", SUNDAY - 60 * DAY),
        ("work-0", "work", SUNDAY - 90 * DAY),
        ("undated", "", None),
        ("old-3", "", SUNDAY - 40 * DAY),
        ("young", "", SUNDAY - DAY),
    ):
        probe.insert(
            "gtd_snapshot_tasks",
            day="2026-10-04",
            task_id=task_id,
            project_id=project,
            priority=1,
            added_at=added,
            content_hmac="0" * 64,
        )
    probe.project("review-project")
    result = review(probe, SUNDAY, TODOIST_REVIEW_PROJECT_ID="review-project")
    [created] = probe.created()
    assert created["title"] == "每周回顾 2026-W40" and created["project_id"] == "review-project"
    body = created["description"]
    assert probe.request_ids() == [request_id(todoist_request_id(created["title"], body, "todofy-review:2026-W40"))]
    assert body.startswith("快照 2026-10-04（Tasks 元数据，只含计数）\n收件箱：开放 23（上周 31，-8）")
    assert "全部项目：开放 57（上周 57，持平） · 逾期 2（上周 2，持平） · 无日期 5（上周 5，持平）" in body
    assert "近 7 天：新建 7 · 完成 9（上周 9，持平）\n邮件任务：1–14 天前收到、仍开着 3（晨报最多带入 30 条）\n" in body
    # Title-free links to the snapshot day's three oldest inbox tasks, oldest first (other projects and
    # undated rows are not candidates).
    oldest = [f"{TASKS_ORIGIN}/?task=old-{n}" for n in (1, 2, 3)]
    assert f"收件箱最老的任务：{'  '.join(oldest)}\n" in body
    assert "本周重点：收件箱里超过 30 天的 1 项：逐个决定 做 / 委派 / 删除\n" in body
    assert "Todofy：需处理事件 0；运维：（仪表盘报告 2026-10-03 23:00 UTC）mail-hero parse_failed count=1\n" in body
    assert "backup_active" not in body  # info items are not listed
    assert f"面板：https://home.ziyixi.science/   Todofy GTD：https://{PUBLIC_HOST}/gtd" in body
    [row] = probe.sql("SELECT week, state, project_id, task_id, attempts, subject FROM gtd_reviews")
    assert row == {
        "week": "2026-W40",
        "state": "created",
        "project_id": "review-project",
        "task_id": created["id"],
        "attempts": 1,
        "subject": "每周回顾 2026-W40",
    }
    assert result["state"]["next_review"] == SUNDAY + 7 * DAY
    assert result["facts"]["first_review_at"] == SUNDAY
    # Later the same evening (a restarted schedule, say): still one task.
    again = review(probe, SUNDAY + 2 * HOUR)
    assert len(probe.created()) == 1 and again["state"]["next_review"] == SUNDAY + 7 * DAY


# The deploy uploads an unset optional project as a single space (the secret must be overwritten,
# not kept), so a blank value must read as unset.
@pytest.mark.parametrize("unset", [{}, {"TODOIST_REVIEW_PROJECT_ID": " "}])
def test_the_review_goes_to_the_inbox_without_a_review_project(probe, unset):
    review(probe, SUNDAY, **unset)
    [created] = probe.created()
    assert created["project_id"] == ""
    assert created["description"].startswith("快照：本周没有可用的 Tasks 快照")


def test_the_review_links_plans_checklist_once_planning_is_set_up(probe):
    review(probe, SUNDAY)
    assert "review=1" not in probe.created()[0]["description"]
    probe.insert("plus_settings", id=1, mapping="{}", timezone="UTC", week_start="2026-09-28", enabled=1)
    try:
        review(probe, SUNDAY + 7 * DAY)
    finally:
        probe.sql("DELETE FROM plus_settings")
    [_, later] = probe.created()
    assert later["description"].endswith(f"   周回顾：{TASKS_ORIGIN}/?review=1#/plan\n")


def test_a_failed_review_is_retried_hourly_then_stops(probe):
    now = SUNDAY
    assert review(probe, now, **MISSING)["state"]["next_review"] == now + HOUR
    for attempt in range(2, 6):
        now += HOUR
        expected = now + HOUR if attempt < 5 else SUNDAY + 7 * DAY
        assert review(probe, now)["state"]["next_review"] == expected
    [row] = probe.sql("SELECT state, attempts, last_error_code, project_id FROM gtd_reviews")
    assert row == {
        "state": "failed",
        "attempts": 5,
        "last_error_code": "review_create_failed",
        "project_id": "review-project",
    }
    review(probe, now + HOUR)
    assert probe.created() == []


def test_a_retried_review_sends_its_frozen_request(probe):
    review(probe, SUNDAY, **MISSING)
    [frozen] = probe.sql("SELECT subject, body FROM gtd_reviews")
    seed_days(probe, "2026-10-04", inbox_open=1, all_open=1)  # a later body would differ: it must not be used
    probe.project("review-project")
    review(probe, SUNDAY + HOUR)
    [created] = probe.created()
    assert (created["title"], created["description"]) == (frozen["subject"], frozen["body"])
    assert probe.request_ids() == [
        request_id(todoist_request_id(frozen["subject"], frozen["body"], "todofy-review:2026-W40"))
    ]


def test_failed_retries_stop_when_the_iso_week_ends(probe):
    late = SUNDAY + 6 * HOUR + 30 * 60  # 23:30 UTC
    assert review(probe, late, **MISSING)["state"]["next_review"] == SUNDAY + 7 * DAY


def test_an_unknown_review_is_never_resent(probe):
    probe.insert(
        "gtd_reviews",
        week="2026-W40",
        state="unknown",
        subject="t",
        body="b",
        attempts=1,
        last_error_code="review_result_unknown",
        created_at=SUNDAY,
        updated_at=SUNDAY,
    )
    review(probe, SUNDAY + 60)
    review(probe, SUNDAY + HOUR)
    assert probe.created() == []


def test_a_week_left_sending_is_recorded_as_interrupted_and_not_resent(probe):
    probe.insert(
        "gtd_reviews", week="2026-W40", state="sending", subject="t", body="b", created_at=SUNDAY, updated_at=SUNDAY
    )
    review(probe, SUNDAY + 60)
    assert probe.created() == []
    assert probe.sql("SELECT state, attempts, last_error_code FROM gtd_reviews") == [
        {"state": "unknown", "attempts": 1, "last_error_code": "interrupted_review_call"}
    ]


@pytest.mark.parametrize(
    "overrides", [{"GTD_REVIEW_ENABLED": "false"}, {"FORCE_PAUSE_TODOIST": "true"}], ids=["disabled", "paused"]
)
def test_no_review_while_disabled_or_paused(probe, overrides):
    result = probe.call("/gtd", op="tick", now=SUNDAY, state=only_review(SUNDAY), vars=ENABLED | overrides)
    assert probe.created() == [] and probe.sql("SELECT week FROM gtd_reviews") == []
    assert result["state"]["next_review"] == SUNDAY + 600


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
    assert probe.created() == []


def test_the_iso_week_crosses_the_year_end(probe):
    new_year = int(datetime(2027, 1, 3, 17, tzinfo=UTC).timestamp())
    review(probe, new_year)
    review(probe, new_year + 7 * DAY)
    assert [row["week"] for row in probe.sql("SELECT week FROM gtd_reviews ORDER BY week")] == ["2026-W53", "2027-W01"]
    assert [task["title"] for task in probe.created()] == ["每周回顾 2026-W53", "每周回顾 2027-W01"]


def test_a_completed_review_is_seen_by_the_next_snapshot(probe):
    review(probe, SUNDAY)
    [task] = probe.created()
    complete(probe, task["id"], SUNDAY + 3 * HOUR)
    monday = SUNDAY + 20 * HOUR  # Monday 13:00 UTC
    result = tick(probe, monday, state={"next_collect": 0, "next_review": monday + DAY})
    assert probe.sql("SELECT completed_at FROM gtd_reviews") == [{"completed_at": SUNDAY + 3 * HOUR}]
    assert result["facts"]["last_review_at"] == SUNDAY + 3 * HOUR
    assert result["facts"]["review_age_days"] == 0
    later = probe.call("/gtd", op="facts", now=SUNDAY + 3 * HOUR + 11 * DAY, vars=ENABLED)
    assert later["facts"]["review_age_days"] == 11
    # Without the daily snapshot nothing would see the next review done: no age, so no review_overdue.
    off = probe.call("/gtd", op="facts", now=SUNDAY + 3 * HOUR + 11 * DAY, vars=ENABLED | {"GTD_COLLECT_UTC": "off"})
    assert off["facts"]["review_age_days"] is None
    paused = probe.call("/gtd", op="facts", now=SUNDAY + 11 * DAY, vars=ENABLED | {"FORCE_PAUSE_TODOIST": "true"})
    assert paused["facts"]["review_age_days"] is None
    # A deleted review task never counts as done.
    review(probe, SUNDAY + 7 * DAY)
    second = probe.created()[-1]["id"]
    probe.worker.tasks_d1(f"UPDATE tasks SET deleted_at = {(SUNDAY + 7 * DAY + HOUR) * 1000} WHERE id = '{second}'")
    tick(probe, SUNDAY + 7 * DAY + 20 * HOUR, state={"next_collect": 0, "next_review": SUNDAY + 14 * DAY})
    rows = probe.sql("SELECT week, completed_at FROM gtd_reviews ORDER BY week")
    assert rows == [{"week": "2026-W40", "completed_at": SUNDAY + 3 * HOUR}, {"week": "2026-W41", "completed_at": None}]


def test_the_owner_api_series(probe):
    seed_days(probe, TODAY, inbox_open=4, all_open=6)
    review(probe, SUNDAY)
    daily = probe.call("/gtd/daily", days=3, now=NOW)["daily"]
    assert [(day["day"], day["recorded"]) for day in daily["days"]] == [
        (gtd.shift(TODAY, -2), False),
        (YESTERDAY, False),
        (TODAY, True),
    ]
    assert daily["days"][-1]["inbox"]["open"] == 4
    assert daily["latest_review"]["week"] == "2026-W40" and daily["latest_review"]["state"] == "created"


def test_the_owner_api_pages_newest_first(probe):
    """todofy.ui.v1 ListGtdDays and ListGtdReviews: newest first, a page at a time, never past what is kept."""
    seed_days(probe, TODAY, inbox_open=4, all_open=6)
    first = probe.call("/gtd/days", size=2, now=NOW)
    assert [(day["day"], day["recorded"]) for day in first["days"]] == [(TODAY, True), (YESTERDAY, False)]
    assert first["before"] == YESTERDAY
    assert all(idl_errors("GtdDay", day) == [] for day in first["days"])
    second = probe.call("/gtd/days", size=2, before=first["before"], now=NOW)
    assert [day["day"] for day in second["days"]] == [gtd.shift(TODAY, -2), gtd.shift(TODAY, -3)]
    # The oldest page stops at the DAILY_DAYS kept and has no next page.
    last = probe.call("/gtd/days", size=10, before=gtd.shift(TODAY, -115), now=NOW)
    assert [day["day"] for day in last["days"]] == [gtd.shift(TODAY, -n) for n in range(116, 120)]
    assert last["before"] is None
    for sunday in (SUNDAY, SUNDAY + 7 * DAY, SUNDAY + 14 * DAY):
        review(probe, sunday)
    reviews = probe.call("/gtd/reviews", size=2, now=SUNDAY + 15 * DAY)
    assert [row["week"] for row in reviews["reviews"]] == ["2026-W42", "2026-W41"] and reviews["last"] == "2026-W41"
    assert all(idl_errors("GtdReview", row) == [] for row in reviews["reviews"])
    rest = probe.call("/gtd/reviews", size=2, before=reviews["last"], now=SUNDAY + 15 * DAY)
    assert ([row["week"] for row in rest["reviews"]], rest["last"]) == (["2026-W40"], None)


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
    """The privacy sweep: sentinel titles and descriptions reach the Worker in every Tasks answer and
    must appear nowhere it writes: D1, the object's state, the review task, the API, the log."""
    ids = seed(
        probe,
        *({"title": f"{SENTINEL}-{n}", "labels": ["家"], "project": "" if n % 2 else "work"} for n in range(5)),
        {"title": f"{SENTINEL}-done", "added": NOW - DAY},
    )
    complete(probe, ids[-1], NOW - HOUR)
    for event_id, task_id in (("m1", ids[0]), ("m2", ids[1])):
        probe.insert(
            "summaries",
            event_id=event_id,
            created_at=NOW - 2 * DAY,
            subject="s",
            summary="合成摘要",
            model="m",
            task_id=task_id,
            triaged_at=NOW - 2 * DAY,
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
        json.dumps([task for task in probe.created() if task["title"].startswith("每周回顾")], ensure_ascii=False),
        json.dumps(probe.call("/gtd/daily", days=7, now=NOW), ensure_ascii=False),
        (probe.worker.persist_to / "dev.log").read_text(errors="replace"),
    ]
    assert probe.sql("SELECT count(*) AS n FROM gtd_snapshot_tasks") == [{"n": 5}]
    for text in written:
        assert "SENTINEL" not in text
        assert SENTINEL_DESC not in text
