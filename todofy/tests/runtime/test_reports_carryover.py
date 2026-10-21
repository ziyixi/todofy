"""The morning brief that remembers (core/carryover.py) in real workerd: the recommendation also sees the mail
of the last 14 days that still awaits a decision in Mail, tagged "[N 天前]" and spread over the days it
arrived; with the carryover switched off, after a failed attempt that day, or when the token budget cannot take
the carried lines, the model input, prompt and payload are exactly the 24 h report; and the [Todofy System]
reminder goes to its own project, frozen with the day's claim."""

import json
import time
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
import pytest

from tests.fakes.gemini_fake import text_reply
from tests.runtime.reports_support import (  # noqa: F401
    NEWSLETTER,
    NOW,
    Probe,
    clean_fixture,
    idl_errors,
    probe_fixture,
)
from todofy.core import carryover, prompts

DAY = 86_400
HOUR = 3_600
TODAY = datetime.fromtimestamp(NOW, UTC).strftime("%Y-%m-%d")
SCHEMA = json.loads((Path(__file__).parents[2] / "api" / "recommendation-v1.schema.json").read_text())
TASKS = [{"rank": 1, "title": "续签护照", "reason": "两周前的提醒仍未处理。"}]


def summary(probe: Probe, event_id: str, created_at: int, text: str, **columns: object) -> None:
    probe.insert("summaries", event_id=event_id, created_at=created_at, subject="s", summary=text, model="m", **columns)


@pytest.fixture
def mail(probe: Probe) -> None:
    """Two new summaries and five older ones: two still pending, one converted, one imported, one too old."""
    summary(probe, "new-1", NOW - 5 * HOUR, "新邮件一")
    summary(probe, "new-2", NOW - HOUR, "新邮件二")
    summary(probe, "old-pending-2d", NOW - 2 * DAY - HOUR, "两天前仍待处理")
    summary(probe, "old-pending-9d", NOW - 9 * DAY, "九天前仍待处理")
    summary(probe, "old-converted", NOW - 3 * DAY, "已转成任务的旧邮件", task_id="t-done", triaged_at=NOW - 2 * DAY)
    summary(probe, "old-imported", NOW - 4 * DAY, "导入的旧邮件", imported=1)
    summary(probe, "too-old", NOW - 15 * DAY, "十五天前")


def recommendation(probe: Probe, **overrides: str) -> dict:
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    result = probe.call("/reports/compute", kind="recommendation", top_n=10, now=NOW, budget_ms=10_000, vars=overrides)
    return result["report"]


def test_older_pending_mail_is_carried_after_the_new_mail(probe, mail):
    report = recommendation(probe)
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10, carryover=True)
    # New mail first (oldest first, as before), then the carried mail, newest first.
    carried = ["[2 天前] 两天前仍待处理", "[9 天前] 九天前仍待处理"]
    assert prompts.report_input(["新邮件一", "新邮件二", *carried]) in call.user
    for text in ("已转成任务的旧邮件", "导入的旧邮件", "十五天前"):
        assert text not in call.user
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == ("ok", 4, 2, 2)
    assert report["tasks"] == TASKS
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(report)) == []
    [stored] = probe.sql("SELECT task_count, payload_json FROM daily_reports")
    assert stored["task_count"] == 4 and json.loads(stored["payload_json"]) == report


def test_carryover_is_capped_at_30_and_spread_over_the_days(probe):
    """A normal volume: 35 pending mail from yesterday must not push out the mail pending for 5 and 12 days."""
    for index in range(35):
        summary(probe, f"e{index}", NOW - DAY - 60 * (index + 1), f"昨天 {index}")
    summary(probe, "d5", NOW - 5 * DAY, "五天前仍待处理")
    summary(probe, "d12", NOW - 12 * DAY, "十二天前仍待处理")
    report = recommendation(probe)
    [call] = probe.gemini.calls()
    lines = [line for line in call.user.splitlines() if line.startswith("[")]
    assert len(lines) == 30 and "[5 天前] 五天前仍待处理" in lines and lines[-1] == "[12 天前] 十二天前仍待处理"
    assert lines[:28] == [f"[1 天前] 昨天 {index}" for index in range(28)]  # newest first
    assert (report["new_count"], report["carryover_count"], report["task_count"]) == (0, 30, 30)
    assert report["status"] == "ok"  # no new mail, but pending mail: not an empty window


def test_a_long_stored_summary_is_carried_cut(probe, mail):
    summary(probe, "long", NOW - 3 * DAY, "长" * 20_000)
    recommendation(probe)
    [call] = probe.gemini.calls()
    [line] = [line for line in call.user.splitlines() if line.startswith("[3 天前]")]
    assert len(line.encode()) <= carryover.CARRYOVER_LINE_BYTES + len("[3 天前] ".encode())


def test_switched_off_the_report_is_exactly_the_24_hour_one(probe, mail):
    report = recommendation(probe, REPORT_CARRYOVER_DAYS="0")
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10)
    assert prompts.report_input(["新邮件一", "新邮件二"]) in call.user and "天前" not in call.user
    assert (report["task_count"], report["new_count"], report["carryover_count"]) == (2, 2, 0)


@pytest.mark.parametrize("marker", ["INDEXED BY summaries_pending", "substr(summary, 1, ?)"], ids=["pending", "lines"])
def test_a_failed_carryover_read_falls_back_to_the_24_hour_report(probe, mail, marker):
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "fail_sql": marker}
    report = probe.call("/reports/compute", **args)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("ok", 2, 0)


def test_after_a_failed_attempt_today_the_report_is_exactly_the_24_hour_one(probe, mail):
    """A Gemini error or unusable answer with the carryover costs the brief one attempt at most."""
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    failures = {f"recommendation/10/{TODAY}": 1}
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "failures": failures}
    report = probe.call("/reports/compute", **args)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("ok", 2, 0)


def test_a_token_budget_too_small_for_the_carryover_falls_back_to_the_24_hour_report(probe, mail):
    # What the 24 h report alone reserves.
    plain = probe.call(
        "/reports/compute",
        kind="recommendation",
        top_n=10,
        now=NOW,
        budget_ms=10_000,
        tokens=False,
        vars={"REPORT_CARRYOVER_DAYS": "0"},
    )
    [[_, reserve, _]] = [call for call in plain["budget"] if call[0] == "reserve"]
    probe.gemini.queue_generate(text_reply(json.dumps(TASKS, ensure_ascii=False)))
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "token_limit": reserve}
    result = probe.call("/reports/compute", **args)
    reserves = [call[1] for call in result["budget"] if call[0] == "reserve"]
    assert len(reserves) == 2 and reserves[0] > reserve and reserves[1] == reserve
    [call] = probe.gemini.calls()  # one Gemini call: the refused reservation made none
    assert call.system == prompts.recommend_prompt(10) and "天前" not in call.user
    report = result["report"]
    assert (report["status"], report["task_count"], report["new_count"], report["carryover_count"]) == ("ok", 2, 2, 0)


def test_without_new_mail_a_refused_carryover_is_an_empty_window(probe):
    summary(probe, "old", NOW - 3 * DAY, "三天前仍待处理")
    args = {"kind": "recommendation", "top_n": 10, "now": NOW, "budget_ms": 10_000, "tokens": False}
    report = probe.call("/reports/compute", **args)["report"]
    assert (report["status"], report["new_count"], report["carryover_count"]) == ("empty_window", 0, 0)
    assert probe.gemini.calls() == []


def test_an_empty_day_without_pending_mail_is_still_an_empty_window(probe):
    summary(probe, "converted", NOW - 3 * DAY, "已处理", task_id="t-done", triaged_at=NOW - DAY)
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
    probe.gemini.queue_generate(text_reply("日报"))
    report = probe.call("/reports/compute", kind="summary", top_n=0, now=NOW, budget_ms=10_000)["report"]
    [call] = probe.gemini.calls()
    assert call.system == prompts.SUMMARY_RANGE and "天前" not in call.user
    assert report["task_count"] == 2 and "carryover_count" not in report


def test_the_newsletter_gets_the_counts_on_demand(probe):
    """reports.serve computes on demand at the real time: seed around it."""
    now = int(time.time())
    summary(probe, "new", now - HOUR, "新邮件")
    summary(probe, "old", now - 3 * DAY, "三天前仍待处理")
    response = probe.worker.hooks.get("/api/recommendation", params={"top": "10"}, auth=NEWSLETTER)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["new_count"], body["carryover_count"], body["task_count"]) == (1, 1, 2)
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(body)) == []
    # A report stored before the change (no counts) is still valid.
    old = {key: value for key, value in body.items() if key not in ("new_count", "carryover_count")}
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(old)) == []
    latest = probe.call("/reports/latest")["latest"]
    assert idl_errors("LatestReports", latest) == []


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
    probe.project("ops-project")
    probe.call("/reminder/tick", now=NOW, vars={"TODOIST_OPS_PROJECT_ID": "ops-project"})
    [created] = probe.created()
    assert created["project_id"] == "ops-project"
    assert probe.sql("SELECT project_id FROM mail_reminders") == [{"project_id": "ops-project"}]


# The deploy uploads an unset optional project as a single space (the secret must be overwritten,
# not kept), so a blank value must read as unset.
@pytest.mark.parametrize("unset", [{}, {"TODOIST_OPS_PROJECT_ID": " "}])
def test_without_an_ops_project_the_reminder_goes_to_the_inbox(probe, unset):
    attention(probe)
    probe.call("/reminder/tick", now=NOW, vars=unset)
    [created] = probe.created()
    assert created["project_id"] == ""
    assert probe.sql("SELECT project_id FROM mail_reminders") == [{"project_id": ""}]


def test_a_retry_keeps_the_frozen_project_after_the_setting_changed(probe):
    attention(probe)
    probe.call("/reminder/tick", now=NOW, vars={"TODOIST_OPS_PROJECT_ID": "ops-project"})  # Tasks has none yet
    assert probe.created() == []
    probe.project("ops-project")
    probe.project("another-project")
    probe.call("/reminder/tick", now=NOW + HOUR, vars={"TODOIST_OPS_PROJECT_ID": "another-project"})
    [created] = probe.created()
    assert created["project_id"] == "ops-project"


def test_a_day_claimed_before_the_migration_retries_into_the_inbox(probe):
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
    [created] = probe.created()
    assert (created["title"], created["description"], created["project_id"]) == ("t", "b", "")
