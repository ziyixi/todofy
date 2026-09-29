"""Eviction mid-call: workerd is killed while an upstream call hangs, then restarted on the same storage.

The cron tick after each restart stands in for the persisted watchdog alarm, so no
test depends on how quickly local workerd replays an overdue alarm.
"""

import time

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.server import Reply
from tests.fakes.todoist_fake import TASKS_PATH, TodoistFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, settled_reminder, transitions, wait_until
from todofy.core.backoff import SUMMARY_CRASH_LIMIT
from todofy.core.reminder_text import TITLE_PREFIX

# Long upstream deadlines keep every call in flight until the process dies.
SLOW = {"GEMINI_TIMEOUT_MS": "60000", "TODOIST_ATTEMPT_TIMEOUT_MS": "60000"}


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    return launch(**SLOW)


def _restart_and_wake(worker: Worker) -> None:
    worker.crash_and_restart()
    assert worker.trigger_cron().status_code == 200


@pytest.mark.reaches("processing_interrupted_limit")
def test_three_interrupted_summaries_stop_automatic_retries(worker: Worker, fresh_gemini: GeminiFake) -> None:
    for _ in range(SUMMARY_CRASH_LIMIT):
        fresh_gemini.queue_generate(Reply(hang=True))
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204

    for crash in range(1, SUMMARY_CRASH_LIMIT + 1):
        fresh_gemini.wait_for(lambda n=crash: len(fresh_gemini.calls_mentioning(event_id)) == n, timeout_s=30)
        _restart_and_wake(worker)

    event = worker.wait_event(event_id, {"failed_summary"})
    assert (event["error_code"], event["crashes"]) == ("processing_interrupted_limit", SUMMARY_CRASH_LIMIT)
    assert event["allowed_actions"] == ["retry_summary", "dismiss"]
    time.sleep(3)
    assert len(fresh_gemini.calls_mentioning(event_id)) == SUMMARY_CRASH_LIMIT
    # Each interrupted call's reservation is settled as spent, not left reserved all day.
    usage = worker.overview()["gemini"]
    assert (usage["reserved_tokens"], usage["calls"]) == (0, SUMMARY_CRASH_LIMIT)
    assert usage["used_tokens"] > 0


@pytest.mark.reaches("interrupted_todo_call")
def test_an_interrupted_task_call_is_unknown_and_resolved_by_the_lookup(
    worker: Worker, fresh_todoist: TodoistFake
) -> None:
    # Todoist commits the task but the answer never arrives before the isolate dies.
    fresh_todoist.queue("POST", TASKS_PATH, Reply(hang=True, applied=True))
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    fresh_todoist.wait_for(lambda: fresh_todoist.creates_for(event_id), timeout_s=30)

    _restart_and_wake(worker)

    event = worker.wait_event(event_id, {"complete"})
    assert ("todo_sending", "todo_unknown", "interrupted_todo_call", "worker") in transitions(event)
    [task] = fresh_todoist.tasks
    assert event["task_id"] == task.id and len(fresh_todoist.creates_for(event_id)) == 1


@pytest.mark.reaches("interrupted_reminder_call")
def test_an_interrupted_reminder_is_unknown_and_not_resent_that_day(launch: Launch, fresh_todoist: TodoistFake) -> None:
    worker = launch(REMINDER_ENABLED="true", **SLOW)
    fresh_todoist.queue("POST", TASKS_PATH, Reply(hang=True))
    event_id, body = mail_event(needs_review=True)
    assert worker.post_event(body).status_code == 204
    fresh_todoist.wait_for(lambda: fresh_todoist.creates(), timeout_s=30)

    _restart_and_wake(worker)

    worker.wait_event(event_id, {"failed_summary"})
    today = wait_until(lambda: settled_reminder(worker), 30, "reminder outcome")
    assert (today["state"], today["error_code"], today["task_id"]) == (
        "unknown",
        "interrupted_reminder_call",
        None,
    )
    assert worker.trigger_cron().status_code == 200
    time.sleep(3)
    assert [p.json()["content"].startswith(TITLE_PREFIX) for p in fresh_todoist.creates()] == [True]
