"""The daily owner reminder: claimed once per UTC day, then created, failed (retried hourly) or unknown.

Each outcome needs a fresh UTC-day claim, hence one Worker per test. Tasks refuses a reminder into a project
it does not have; an unknown outcome is seeded, since a real Tasks call cannot be made to lose its answer.
"""

import time
from datetime import UTC, datetime, timedelta

import pytest
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

from tests.runtime import tasks_support as tasks
from tests.runtime.conftest import Launch
from tests.runtime.harness import PUBLIC_HOST, Worker, mail_event, settled_reminder, wait_until
from tests.runtime.owner_support import assert_message
from todofy.core.reminder_text import SENDER, TITLE_PREFIX, reminder_title
from todofy.core.request_id import todoist_request_id
from todofy.runtime.native_tasks import request_id


def _attention(worker: Worker, subject: str = "私密主题") -> str:
    """A review-flagged mail is attention at once, without Gemini or Tasks."""
    event_id, body = mail_event(subject=subject, needs_review=True, text="私密正文 secret-body")
    assert worker.post_event(body).status_code == 204
    worker.wait_event(event_id, {"failed_summary"})
    return event_id


def _reminders(worker: Worker) -> list[dict]:
    return [task for task in tasks.created(worker) if task["title"].startswith(TITLE_PREFIX)]


def _outcome(worker: Worker) -> dict:
    return wait_until(lambda: settled_reminder(worker), 30, "reminder outcome")


def _stamp(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def test_one_reminder_per_utc_day_lists_ids_but_no_mail_content(launch: Launch) -> None:
    worker = launch(REMINDER_ENABLED="true")
    event_id = _attention(worker)

    reminder = _outcome(worker)

    [task] = _reminders(worker)
    assert (task["title"], task["project_id"]) == (reminder_title(1), "")  # the Inbox
    assert f"- {event_id} · failed_summary · mail_needs_review · 收到 " in task["description"]
    assert f"https://{PUBLIC_HOST}/attention" in task["description"]
    assert "私密" not in task["title"] + task["description"] and "secret-body" not in task["description"]
    assert "sender@example.org" not in task["description"]
    assert request_id(todoist_request_id(task["title"], task["description"], SENDER)) in tasks.request_ids(worker)
    assert (reminder["state"], reminder["task_id"], reminder["attention_count"]) == ("created", task["id"], 1)
    assert worker.overview()["latest_reminder"]["name"] == reminder["name"]
    assert_message(worker.owner.get("/api/v1/dailyReminders"), pb.ListDailyRemindersResponse)

    _attention(worker, subject="第二封")
    assert worker.trigger_cron().status_code == 200
    time.sleep(3)
    assert len(_reminders(worker)) == 1


@pytest.mark.reaches("reminder_create_failed")
def test_a_rejected_reminder_is_failed_and_retried_hourly(launch: Launch) -> None:
    worker = launch(REMINDER_ENABLED="true", TODOIST_OPS_PROJECT_ID="missing-project")
    _attention(worker)

    reminder = _outcome(worker)

    assert (reminder["state"], reminder["error_code"], reminder["attempt_count"]) == (
        "failed",
        "reminder_create_failed",
        1,
    )
    retry_at = _stamp(reminder["next_attempt_time"]) - datetime.now(UTC)
    assert timedelta(minutes=55) < retry_at <= timedelta(hours=1)
    assert _reminders(worker) == []


@pytest.mark.reaches("reminder_result_unknown")
def test_a_reminder_with_an_unknown_result_is_not_resent_that_day(launch: Launch) -> None:
    worker = launch(REMINDER_ENABLED="true")
    now = int(time.time())
    worker.d1(
        "INSERT INTO mail_reminders (day, state, subject, body, attention_count, attempts, last_error_code,"
        f" created_at, updated_at) VALUES ('{datetime.now(UTC).date().isoformat()}', 'unknown', 't', 'b', 1, 1,"
        f" 'reminder_result_unknown', {now}, {now})"
    )
    _attention(worker)

    reminder = _outcome(worker)
    _attention(worker, subject="再来一封")
    assert worker.trigger_cron().status_code == 200
    time.sleep(3)

    assert (reminder["state"], reminder["error_code"], reminder["task_id"]) == (
        "unknown",
        "reminder_result_unknown",
        None,
    )
    assert _reminders(worker) == []


def test_no_reminder_without_attention_or_when_disabled(launch: Launch) -> None:
    quiet = launch(REMINDER_ENABLED="true")
    disabled = launch(REMINDER_ENABLED="false")
    _attention(disabled)
    for worker in (quiet, disabled):
        assert worker.trigger_cron().status_code == 200
    time.sleep(3)

    assert _reminders(quiet) == [] and _reminders(disabled) == []
    assert disabled.overview()["switches"]["reminder_enabled"] is False
