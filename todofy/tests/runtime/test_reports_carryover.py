"""The morning brief that remembers (docs/gtd-features.md §3) in real workerd: the recommendation also
sees mail tasks of the last 14 days that the day's Todoist snapshot still lists as open, tagged
"[N 天前]"; without a usable snapshot the model input, prompt and payload are exactly the 24 h report;
and the [Todofy System] reminder goes to its own project, frozen with the day's claim."""

import json
import time
from pathlib import Path

import jsonschema
import pytest

from tests.fakes.gemini_fake import text_reply
from tests.fakes.server import Reply
from tests.fakes.todoist_fake import PROJECT_ID, TASKS_PATH
from tests.runtime.reports_support import (  # noqa: F401
    NEWSLETTER,
    NOW,
    Probe,
    clean_fixture,
    component_errors,
    probe_fixture,
)
from todofy.core import gtd, prompts

DAY = 86_400
HOUR = 3_600
TODAY = gtd.day_of(NOW)
SCHEMA = json.loads((Path(__file__).parents[2] / "api" / "recommendation-v1.schema.json").read_text())
TASKS = [{"rank": 1, "title": "续签护照", "reason": "两周前的提醒仍未处理。"}]


def snapshot(
    probe: Probe, task_ids: list[str], *, status: str = "ok", finished_at: int = NOW - 2 * HOUR, day: str = TODAY
) -> None:
    probe.insert(
        "gtd_snapshots",
        day=day,
        status=status,
        task_count=len(task_ids),
        started_at=finished_at - 60,
        finished_at=finished_at,
    )
    for task_id in task_ids:
        probe.insert(
            "gtd_snapshot_tasks", day=day, task_id=task_id, project_id=PROJECT_ID, priority=1, content_hmac="0" * 64
        )


def summary(probe: Probe, event_id: str, created_at: int, text: str, task_id: str = "") -> None:
    probe.insert(
        "summaries", event_id=event_id, created_at=created_at, subject="s", summary=text, model="m", task_id=task_id
    )


@pytest.fixture
def mail(probe: Probe) -> None:
    """Two new summaries and four older ones: two still open, one closed, one without a task."""
    summary(probe, "new-1", NOW - 5 * HOUR, "新邮件一", "t-new-1")
    summary(probe, "new-2", NOW - HOUR, "新邮件二", "t-new-2")
    summary(probe, "old-open-2d", NOW - 2 * DAY - HOUR, "两天前仍开着", "t-open-2")
    summary(probe, "old-open-9d", NOW - 9 * DAY, "九天前仍开着", "t-open-9")
    summary(probe, "old-closed", NOW - 3 * DAY, "已完成的旧任务", "t-closed")
    summary(probe, "old-no-task", NOW - 4 * DAY, "没有任务的旧邮件")
    summary(probe, "too-old", NOW - 15 * DAY, "十五天前", "t-open-15")


def recommendation(probe: Probe, **overrides: str) -> dict:
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    result = probe.call("/reports/compute", kind="recommendation", top_n=10, now=NOW, budget_ms=10_000, vars=overrides)
    return result["report"]


def test_open_older_mail_tasks_are_carried_after_the_new_ones(probe, mail):
    snapshot(probe, ["t-new-2", "t-open-2", "t-open-9", "t-open-15"])
    report = recommendation(probe)
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10, carryover=True)
    # New mail first (oldest first, as before), then the carried tasks, newest first.
    assert prompts.report_input(["新邮件一", "新邮件二", "[2 天前] 两天前仍开着", "[9 天前] 九天前仍开着"]) in call.user
    assert "已完成的旧任务" not in call.user and "没有任务的旧邮件" not in call.user and "十五天前" not in call.user
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == ("ok", 4, 2, 2)
    assert report["tasks"] == TASKS
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(report)) == []
    [stored] = probe.sql("SELECT task_count, payload_json FROM daily_reports")
    assert stored["task_count"] == 4 and json.loads(stored["payload_json"]) == report


def test_carryover_is_capped_at_30_newest_first(probe):
    ids = [f"t{index}" for index in range(35)]
    for index, task_id in enumerate(ids):
        summary(probe, f"e{index}", NOW - DAY - HOUR * (index + 1), f"旧 {index}", task_id)
    snapshot(probe, ids)
    report = recommendation(probe)
    [call] = probe.gemini.calls()
    lines = [line for line in call.user.splitlines() if line.startswith("[")]
    assert len(lines) == 30 and lines[0] == "[1 天前] 旧 0" and lines[-1] == "[2 天前] 旧 29"
    assert (report["new_count"], report["carryover_count"], report["task_count"]) == (0, 30, 30)
    assert report["status"] == "ok"  # no new mail, but open tasks: not an empty window


@pytest.mark.parametrize(
    ("setup", "overrides"),
    [
        (lambda probe: None, {}),
        (lambda probe: snapshot(probe, ["t-open-2"], status="failed"), {}),
        (lambda probe: snapshot(probe, ["t-open-2"], status="partial"), {}),
        (lambda probe: snapshot(probe, ["t-open-2"], status="collecting"), {}),
        (lambda probe: snapshot(probe, ["t-open-2"], finished_at=NOW - 26 * HOUR - 1, day=gtd.shift(TODAY, -1)), {}),
        (lambda probe: snapshot(probe, ["t-open-2"]), {"REPORT_CARRYOVER_DAYS": "0"}),
    ],
    ids=["no_snapshot", "failed", "partial", "collecting", "stale", "switched_off"],
)
def test_without_a_usable_snapshot_the_report_is_exactly_the_24_hour_one(probe, mail, setup, overrides):
    setup(probe)
    report = recommendation(probe, **overrides)
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10)
    assert prompts.report_input(["新邮件一", "新邮件二"]) in call.user and "天前" not in call.user
    assert (report["task_count"], report["new_count"], report["carryover_count"]) == (2, 2, 0)


@pytest.mark.parametrize("marker", ["FROM gtd_snapshots", "FROM gtd_snapshot_tasks g"], ids=["snapshot", "carryover"])
def test_a_failed_carryover_read_falls_back_to_the_24_hour_report(probe, mail, marker):
    snapshot(probe, ["t-open-2", "t-open-9"])
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "fail_sql": marker}
    report = probe.call("/reports/compute", **args)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("ok", 2, 0)


def test_a_stale_snapshot_just_inside_26_hours_still_serves(probe, mail):
    snapshot(probe, ["t-open-2"], finished_at=NOW - 26 * HOUR, day=gtd.shift(TODAY, -1))
    assert recommendation(probe)["carryover_count"] == 1


def test_an_empty_day_without_open_tasks_is_still_an_empty_window(probe):
    snapshot(probe, ["t-other"])
    report = probe.call("/reports/compute", kind="recommendation", top_n=10, now=NOW, budget_ms=10_000)["report"]
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == (
        "empty_window",
        0,
        0,
        0,
    )
    assert probe.gemini.calls() == []
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(report)) == []


def test_the_summary_report_never_carries(probe, mail):
    snapshot(probe, ["t-open-2", "t-open-9"])
    probe.gemini.queue_generate(text_reply("日报"))
    report = probe.call("/reports/compute", kind="summary", top_n=0, now=NOW, budget_ms=10_000)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.SUMMARY_RANGE and "天前" not in call.user
    assert report["task_count"] == 2 and "carryover_count" not in report


def test_the_newsletter_gets_the_counts_on_demand(probe):
    """reports.serve computes on demand at the real time: seed around it."""
    now = int(time.time())
    summary(probe, "new", now - HOUR, "新邮件", "t-new")
    summary(probe, "old", now - 3 * DAY, "三天前仍开着", "t-old")
    snapshot(probe, ["t-old"], finished_at=now - HOUR, day=gtd.day_of(now - HOUR))
    response = probe.worker.hooks.get("/api/recommendation", params={"top": "10"}, auth=NEWSLETTER)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["new_count"], body["carryover_count"], body["task_count"]) == (1, 1, 2)
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(body)) == []
    # A report stored before the change (no counts) is still valid.
    old = {key: value for key, value in body.items() if key not in ("new_count", "carryover_count")}
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(old)) == []
    latest = probe.call("/reports/latest")["latest"]
    assert component_errors("ReportsLatest", latest) == []


# ---- the reminder's project ------------------------------------------------------------------

SOURCE = "mail-hero-personal"


def attention(probe: Probe) -> None:
    probe.insert(
        "mail_events",
        source_id=SOURCE,
        event_id="e-failed",
        payload_hash="0" * 64,
        payload="{}",
        state="failed_summary",
        last_error_code="summary_failed",
        created_at=NOW - 100,
        updated_at=NOW - 100,
    )


def test_the_reminder_goes_to_the_ops_project_when_one_is_set(probe):
    attention(probe)
    probe.call("/reminder/tick", now=NOW, vars={"TODOIST_OPS_PROJECT_ID": "ops-project"})
    [create] = probe.todoist.creates()
    assert create.json()["project_id"] == "ops-project"
    assert probe.sql("SELECT project_id FROM mail_reminders") == [{"project_id": "ops-project"}]


def test_without_an_ops_project_the_reminder_keeps_the_default_project(probe):
    attention(probe)
    probe.call("/reminder/tick", now=NOW)
    [create] = probe.todoist.creates()
    assert create.json()["project_id"] == PROJECT_ID
    assert probe.sql("SELECT project_id FROM mail_reminders") == [{"project_id": PROJECT_ID}]


def test_a_retry_keeps_the_frozen_project_after_the_setting_changed(probe):
    attention(probe)
    probe.todoist.queue("POST", TASKS_PATH, Reply(400, {"error": "no"}))
    probe.call("/reminder/tick", now=NOW, vars={"TODOIST_OPS_PROJECT_ID": "ops-project"})
    probe.call("/reminder/tick", now=NOW + HOUR, vars={"TODOIST_OPS_PROJECT_ID": "another-project"})
    first, second = probe.todoist.creates()
    assert first.body == second.body and first.headers["x-request-id"] == second.headers["x-request-id"]
    assert second.json()["project_id"] == "ops-project"


def test_a_day_claimed_before_the_migration_retries_into_the_default_project(probe):
    attention(probe)
    probe.insert(
        "mail_reminders",
        day=TODAY,
        state="failed",
        subject="t",
        body="b",
        attention_count=1,
        attempts=1,
        next_attempt_at=NOW,
        created_at=NOW - HOUR,
        updated_at=NOW - HOUR,
    )
    probe.call("/reminder/tick", now=NOW, vars={"TODOIST_OPS_PROJECT_ID": "ops-project"})
    [create] = probe.todoist.creates()
    assert create.json() == {"content": "t", "description": "b", "project_id": PROJECT_ID}
