"""The daily owner reminder: claimed once per UTC day, then created, failed (retried hourly) or unknown.

Each outcome needs a fresh UTC-day claim, hence one Worker per test.
"""

import time
from datetime import UTC, datetime, timedelta

import pytest

from tests.fakes.server import Recorded, Reply
from tests.fakes.todoist_fake import PROJECT_ID, TASKS_PATH, TodoistFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import PUBLIC_HOST, Worker, mail_event, settled_reminder, wait_until
from tests.runtime.owner_support import assert_contract
from todofy.core.reminder_text import SENDER, TITLE_PREFIX, reminder_title
from todofy.core.request_id import todoist_request_id


def _attention(worker: Worker, subject: str = "私密主题") -> str:
    """A review-flagged mail is attention at once, without Gemini or Todoist."""
    event_id, body = mail_event(subject=subject, needs_review=True, text="私密正文 secret-body")
    assert worker.post_event(body).status_code == 204
    worker.wait_event(event_id, {"failed_summary"})
    return event_id


def _reminder_posts(todoist: TodoistFake) -> list[Recorded]:
    return [post for post in todoist.creates() if post.json()["content"].startswith(TITLE_PREFIX)]


def _outcome(worker: Worker) -> dict:
    return wait_until(lambda: settled_reminder(worker), 30, "reminder outcome")


def _stamp(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def test_one_reminder_per_utc_day_lists_ids_but_no_mail_content(launch: Launch, fresh_todoist: TodoistFake) -> None:
    worker = launch(REMINDER_ENABLED="true")
    event_id = _attention(worker)

    reminder = _outcome(worker)

    [post] = _reminder_posts(fresh_todoist)
    task = post.json()
    assert (task["content"], task["project_id"]) == (reminder_title(1), PROJECT_ID)
    assert f"- {event_id} · failed_summary · mail_needs_review · 收到 " in task["description"]
    assert f"https://{PUBLIC_HOST}/attention" in task["description"]
    assert "私密" not in post.body.decode() and "secret-body" not in post.body.decode()
    assert "sender@example.org" not in task["description"]
    assert post.headers["x-request-id"] == todoist_request_id(task["content"], task["description"], SENDER)
    [created] = [t for t in fresh_todoist.tasks if t.content == task["content"]]
    assert (reminder["state"], reminder["task_id"], reminder["attention_count"]) == ("created", created.id, 1)
    assert worker.overview()["latest_reminder"]["day"] == reminder["day"]
    assert_contract(worker.owner.get("/api/v1/reminders"), "/api/v1/reminders")

    _attention(worker, subject="第二封")
    assert worker.trigger_cron().status_code == 200
    time.sleep(3)
    assert len(_reminder_posts(fresh_todoist)) == 1


@pytest.mark.reaches("reminder_create_failed")
def test_a_rejected_reminder_is_failed_and_retried_hourly(launch: Launch, fresh_todoist: TodoistFake) -> None:
    worker = launch(REMINDER_ENABLED="true")
    fresh_todoist.queue("POST", TASKS_PATH, Reply(400, {"error": "bad request"}))
    _attention(worker)

    reminder = _outcome(worker)

    assert (reminder["state"], reminder["error_code"], reminder["attempts"]) == ("failed", "reminder_create_failed", 1)
    retry_at = _stamp(reminder["next_attempt_at"]) - datetime.now(UTC)
    assert timedelta(minutes=55) < retry_at <= timedelta(hours=1)
    assert len(_reminder_posts(fresh_todoist)) == 1


@pytest.mark.reaches("reminder_result_unknown")
@pytest.mark.parametrize("reply", [Reply(500, "boom"), Reply(200, {"no": "id"})], ids=["server_error", "no_id"])
def test_a_reminder_with_an_unknown_result_is_not_resent_that_day(
    launch: Launch, fresh_todoist: TodoistFake, reply: Reply
) -> None:
    worker = launch(REMINDER_ENABLED="true")
    fresh_todoist.queue("POST", TASKS_PATH, reply)
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
    assert len(_reminder_posts(fresh_todoist)) == 1


def test_no_reminder_without_attention_or_when_disabled(launch: Launch, fresh_todoist: TodoistFake) -> None:
    quiet = launch(REMINDER_ENABLED="true")
    disabled = launch(REMINDER_ENABLED="false")
    _attention(disabled)
    for worker in (quiet, disabled):
        assert worker.trigger_cron().status_code == 200
    time.sleep(3)

    assert _reminder_posts(fresh_todoist) == []
    assert disabled.overview()["flags"]["reminder_enabled"] is False
