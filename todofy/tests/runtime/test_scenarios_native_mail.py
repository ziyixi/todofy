"""Native mail completes in the Mailbox; creating a Tasks item is an explicit later action."""

import time
import uuid

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import TodoistFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, sha256_hex, transitions
from tests.runtime.owner_support import event_row, seed


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    # No Tasks binding is installed. Normal mail must finish without calling either task backend,
    # even when task writes are paused.
    return launch(TASK_SOURCE="tasks", FORCE_PAUSE_TODOIST="true")


def test_native_summary_is_stored_without_creating_a_task_and_duplicate_arrival_is_unchanged(
    worker: Worker, fresh_gemini: GeminiFake, fresh_todoist: TodoistFake
) -> None:
    event_id, body = mail_event(subject="Synthetic native Mail only")
    assert worker.post_event(body).status_code == 204
    event = worker.wait_event(event_id, {"complete"})
    assert event["task_id"] is None
    assert event["summary"] and event["summary_model"] == "model-a"
    assert [to for _, to, _, _ in transitions(event)] == ["pending", "summarizing", "complete"]
    assert fresh_todoist.creates_for(event_id) == []
    [saved] = worker.d1(
        "SELECT e.payload, e.todo_body, e.todoist_request_id, s.task_id, s.subject, s.summary, s.model, s.brief"
        f" FROM mail_events e JOIN summaries s USING(event_id) WHERE event_id = '{event_id}'"
    )
    assert saved["payload"] is None
    assert saved["todo_body"] == saved["todoist_request_id"] == saved["task_id"] == ""
    assert saved["subject"] == "Synthetic native Mail only"
    assert saved["summary"] == event["summary"] and saved["brief"]
    assert saved["model"] == "model-a"
    assert worker.post_event(body).status_code == 204
    assert worker.trigger_cron().status_code == 200
    assert len(fresh_gemini.calls_mentioning(event_id)) == 1
    assert worker.d1(f"SELECT count(*) AS n FROM summaries WHERE event_id='{event_id}'") == [{"n": 1}]


def test_frozen_task_jobs_are_not_reclassified_as_new_native_mail(worker: Worker, fresh_todoist: TodoistFake) -> None:
    now = int(time.time())
    frozen, unknown, sending, created = (str(uuid.uuid4()) for _ in range(4))
    rows = []
    for event_id, state in [
        (frozen, "summarized"),
        (unknown, "todo_unknown"),
        (sending, "todo_sending"),
        (created, "todo_created"),
    ]:
        _, body = mail_event(event_id=event_id)
        rows.append(
            event_row(
                event_id,
                state,
                now - 60,
                payload=body.decode(),
                payload_hash=sha256_hex(body),
                summary="Frozen accepted summary",
                summary_model="older-model",
                todo_body="Frozen task request",
                todoist_request_id=f"todofy-{uuid.uuid4().hex[:26]}",
                task_id="existing-task" if state == "todo_created" else "",
                next_attempt_at=now - 1,
            )
        )
    seed(worker, "mail_events", rows)
    assert worker.trigger_cron().status_code == 200
    completed = worker.wait_event(created, {"complete"})
    assert completed["task_id"] == "existing-task"
    # The paused frozen requests and unknown result remain exactly as saved, for normal reconciliation.
    for event_id, state in [(frozen, "summarized"), (unknown, "todo_unknown"), (sending, "todo_unknown")]:
        row = worker.event(event_id)
        assert row["state"] == state and row["summary"] == "Frozen accepted summary"
        assert worker.d1(f"SELECT count(*) AS n FROM summaries WHERE event_id='{event_id}'") == [{"n": 0}]
    assert fresh_todoist.creates() == []
    [linked] = worker.d1(f"SELECT task_id, summary FROM summaries WHERE event_id='{created}'")
    assert linked == {"task_id": "existing-task", "summary": "Frozen accepted summary"}
