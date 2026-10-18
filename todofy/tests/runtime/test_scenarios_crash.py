"""Eviction mid-call: workerd is killed while an upstream call hangs, then restarted on the same storage.

A Tasks call cannot be made to hang, so its interrupted rows are seeded as an evicted run leaves them
(``todo_sending``, a reminder day ``sending``). The cron tick after each restart stands in for the
persisted watchdog alarm, so no test depends on how quickly local workerd replays an overdue alarm.
"""

import time
from datetime import UTC, datetime

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.server import Reply
from tests.runtime import tasks_support as tasks
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, settled_reminder, sha256_hex, transitions, wait_until
from tests.runtime.owner_support import event_row, seed
from todofy.core.backoff import SUMMARY_CRASH_LIMIT
from todofy.core.reminder_text import TITLE_PREFIX
from todofy.core.render import FOOTER_PREFIX

# Long upstream deadlines keep every call in flight until the process dies.
SLOW = {"GEMINI_TIMEOUT_MS": "60000"}


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
    assert (event["error_code"], event["crash_count"]) == ("processing_interrupted_limit", SUMMARY_CRASH_LIMIT)
    assert event["allowed_actions"] == ["retry_summary", "dismiss"]
    time.sleep(3)
    assert len(fresh_gemini.calls_mentioning(event_id)) == SUMMARY_CRASH_LIMIT
    # Each interrupted call's reservation is settled as spent, not left reserved all day.
    usage = worker.overview()["gemini"]
    assert (usage["reserved_tokens"], usage["call_count"]) == (0, SUMMARY_CRASH_LIMIT)
    assert usage["used_tokens"] > 0


@pytest.mark.reaches("interrupted_todo_call")
def test_an_interrupted_task_call_is_unknown_and_resolved_by_the_lookup(worker: Worker) -> None:
    """A row summarised before Mail stopped creating tasks was in its create when the isolate died, after Tasks
    committed the task: the next run calls it unknown, and the footer lookup finds the task."""
    event_id, body = mail_event()
    now = int(time.time())
    frozen = f"Frozen task body\n\n{FOOTER_PREFIX}{event_id}"
    seed(
        worker,
        "mail_events",
        [
            event_row(
                event_id,
                "todo_sending",
                now - 60,
                payload=body.decode(),
                payload_hash=sha256_hex(body),
                summary="Frozen summary",
                summary_model="older-model",
                todo_body=frozen,
                todoist_request_id="todofy-0123456789abcdef0123456789",
            )
        ],
    )
    [task_id] = tasks.seed(worker, {"title": "Frozen mail task", "description": frozen}, now=now)

    _restart_and_wake(worker)

    event = worker.wait_event(event_id, {"complete"})
    assert ("todo_sending", "todo_unknown", "interrupted_todo_call", "worker") in transitions(event)
    assert event["task_id"] == task_id
    assert [task["id"] for task in tasks.created(worker) if event_id in task["description"]] == [task_id]


@pytest.mark.reaches("interrupted_reminder_call")
def test_an_interrupted_reminder_is_unknown_and_not_resent_that_day(launch: Launch) -> None:
    worker = launch(REMINDER_ENABLED="true", **SLOW)
    now = int(time.time())
    seed(
        worker,
        "mail_reminders",
        [
            {
                "day": datetime.now(UTC).date().isoformat(),
                "state": "sending",
                "subject": TITLE_PREFIX + " synthetic",
                "body": "b",
                "attention_count": 1,
                "created_at": now - 60,
                "updated_at": now - 60,
            }
        ],
    )
    event_id, body = mail_event(needs_review=True)
    assert worker.post_event(body).status_code == 204

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
    assert tasks.created(worker) == []
