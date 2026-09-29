"""Reports, reminder and retention through the shipped Worker: the cron wake runs the
coordinator alarm, whose ticks precompute the reports and send the reminder, and
the machine host serves the newsletter endpoints (stored, then on demand)."""

import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from tests.fakes.gemini_fake import API_KEY as GEMINI_KEY
from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import PROJECT_ID, TodoistFake
from tests.fakes.todoist_fake import TOKEN as TODOIST_TOKEN
from tests.runtime.harness import Worker, start_worker
from tests.runtime.owner_support import assert_contract
from tests.runtime.reports_support import NEWSLETTER, digest
from todofy.core.reminder_text import reminder_title

NOW = int(time.time())


class Stack:
    def __init__(self, worker: Worker, gemini: GeminiFake, todoist: TodoistFake) -> None:
        self.worker = worker
        self.gemini = gemini
        self.todoist = todoist

    def until(self, condition: Callable[[], Any], timeout_s: float = 30) -> Any:
        deadline = time.monotonic() + timeout_s
        while not (result := condition()):
            assert time.monotonic() < deadline, "condition not met in time"
            time.sleep(0.5)
        return result


@pytest.fixture(scope="module")
def stack(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Stack]:
    gemini, todoist = GeminiFake(), TodoistFake()
    variables = {
        "GEMINI_API_BASE": gemini.url,
        "GEMINI_API_KEY": GEMINI_KEY,
        "TODOIST_API_BASE": todoist.url,
        "TODOIST_API_KEY": TODOIST_TOKEN,
        "TODOIST_DEFAULT_PROJECT_ID": PROJECT_ID,
        "REPORT_BASIC_AUTH_SHA256": digest(*NEWSLETTER),
        "REPORT_PRECOMPUTE_UTC": "00:00",
        "REMINDER_ENABLED": "true",
    }
    try:
        for worker in start_worker("wrangler.test.toml", tmp_path_factory.mktemp("reports-alarm"), variables):
            # Seeded before the first wake, so the first alarm's ticks see them.
            worker.d1(
                "INSERT INTO summaries (event_id, created_at, subject, summary, model) VALUES"
                f" ('s1', {NOW - 3600}, 's', '报税截止', 'm'), ('s2', {NOW - 600}, 's', '护照到期', 'm');"
                " INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, last_error_code,"
                f" created_at, updated_at) VALUES ('mail-hero-personal', 'e-failed', '{'0' * 64}', '{{}}',"
                f" 'failed_summary', 'summary_failed', {NOW - 60}, {NOW - 60})"
            )
            assert worker.trigger_cron("*/10 * * * *").status_code == 200
            yield Stack(worker, gemini, todoist)
    finally:
        gemini.close()
        todoist.close()


def test_alarm_precomputes_both_reports_once(stack):
    rows = stack.until(
        lambda: (
            len(found := stack.worker.d1("SELECT kind, top_n, status FROM daily_reports ORDER BY kind")) == 2 and found
        )
    )
    assert rows == [
        {"kind": "recommendation", "top_n": 10, "status": "ok"},
        {"kind": "summary", "top_n": 0, "status": "ok"},
    ]
    assert len(stack.gemini.calls()) == 2


def test_newsletter_reads_the_precomputed_reports(stack):
    stack.until(lambda: len(stack.worker.d1("SELECT day FROM daily_reports")) == 2)
    calls = len(stack.gemini.calls())
    summary = assert_contract(stack.worker.hooks.get("/api/summary", auth=NEWSLETTER), "/api/summary")
    assert (summary["status"], summary["task_count"], summary["model"]) == ("ok", 2, "model-a")
    recommendation = assert_contract(
        stack.worker.hooks.get("/api/recommendation?top=10", auth=NEWSLETTER), "/api/recommendation"
    )
    assert (recommendation["status"], recommendation["top_n"], len(recommendation["tasks"])) == ("ok", 10, 3)
    assert len(stack.gemini.calls()) == calls


def test_other_top_is_computed_on_demand_by_the_coordinator(stack):
    response = stack.worker.hooks.get("/api/recommendation?top=4", auth=NEWSLETTER)
    body = assert_contract(response, "/api/recommendation")
    assert (body["status"], body["top_n"]) == ("ok", 4)
    assert stack.worker.d1("SELECT status FROM daily_reports WHERE top_n = 4") == [{"status": "ok"}]


def test_alarm_sends_one_reminder_for_the_day(stack):
    [create] = stack.until(lambda: stack.todoist.creates())
    assert create.json()["content"] == reminder_title(1)
    assert "e-failed · failed_summary · summary_failed" in create.json()["description"]
    [row] = stack.until(lambda: stack.worker.d1("SELECT state, task_id FROM mail_reminders WHERE state != 'sending'"))
    assert row == {"state": "created", "task_id": stack.todoist.tasks[0].id}
    assert stack.worker.trigger_cron("*/10 * * * *").status_code == 200
    time.sleep(2)
    assert len(stack.todoist.creates()) == 1
