"""Mail completes as a summary Todofy keeps; Todofy makes no task. Tasks converts a mail itself through the Mail
entry (test_mail_entry.py)."""

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.runtime import tasks_support as tasks
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, transitions


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    return launch()


def test_a_summary_is_stored_without_a_task_and_a_duplicate_arrival_changes_nothing(
    worker: Worker, fresh_gemini: GeminiFake
) -> None:
    event_id, body = mail_event(subject="Synthetic native Mail only")
    assert worker.post_event(body).status_code == 204
    event = worker.wait_event(event_id, {"complete"})
    assert event["task_id"] is None
    assert event["summary"] and event["summary_model"] == "model-a"
    assert [to for _, to, _, _ in transitions(event)] == ["pending", "summarizing", "complete"]
    [saved] = worker.d1(
        "SELECT e.payload, e.todo_body, e.todoist_request_id, s.task_id, s.subject, s.summary, s.model, s.brief,"
        f" s.triaged_at FROM mail_events e JOIN summaries s USING(event_id) WHERE event_id = '{event_id}'"
    )
    assert saved["payload"] is None and saved["triaged_at"] is None
    assert saved["todo_body"] == saved["todoist_request_id"] == saved["task_id"] == ""
    assert saved["subject"] == "Synthetic native Mail only"
    assert saved["summary"] == event["summary"] and saved["brief"]
    assert saved["model"] == "model-a"
    assert worker.post_event(body).status_code == 204
    assert worker.trigger_cron().status_code == 200
    assert len(fresh_gemini.calls_mentioning(event_id)) == 1
    assert worker.d1(f"SELECT count(*) AS n FROM summaries WHERE event_id='{event_id}'") == [{"n": 1}]
    # Todofy writes no task at all: the Tasks Worker next to it holds none.
    assert tasks.created(worker) == []
