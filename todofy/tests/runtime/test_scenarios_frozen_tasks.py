"""Mail rows summarised before Mail stopped creating tasks: their frozen create and footer lookup run against the
real Tasks Worker (a project Tasks does not have refuses the create), or against no TASKS binding at all.

New mail never reaches these states (test_scenarios_native_mail.py); the rows are seeded as that release left
them. Synthetic data only.
"""

import time
import uuid
from collections.abc import Iterator

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.runtime import tasks_support as tasks
from tests.runtime.conftest import Launch, pipeline_vars
from tests.runtime.harness import Worker, mail_event, sha256_hex, start_gateway, transitions
from tests.runtime.owner_support import event_row, seed
from todofy.core.contract import parse_mail_event
from todofy.core.render import FOOTER_PREFIX, task_title
from todofy.runtime.native_tasks import request_id


def frozen_row(worker: Worker, state: str, **columns: object) -> tuple[str, dict[str, str]]:
    """A mail row in ``state`` with its frozen task request (title, footer-ended body, request ID); both."""
    event_id, body = mail_event()
    frozen = {
        "title": task_title(parse_mail_event(body)),
        "description": f"Frozen task body\n\n{FOOTER_PREFIX}{event_id}",
        "request_id": f"todofy-{uuid.uuid4().hex[:28]}",
    }
    now = int(time.time())
    row = event_row(
        event_id,
        state,
        now - 3600,
        payload=body.decode(),
        payload_hash=sha256_hex(body),
        summary="Frozen summary",
        summary_model="older-model",
        todo_body=frozen["description"],
        todoist_request_id=frozen["request_id"],
        next_attempt_at=now - 1,
    )
    seed(worker, "mail_events", [row | columns])
    assert worker.trigger_cron().status_code == 200
    return event_id, frozen


@pytest.fixture(scope="module")
def unbound(tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake) -> Iterator[Worker]:
    """A core without its TASKS binding."""
    yield from start_gateway(tmp_path_factory.mktemp("unbound"), pipeline_vars(gemini), tasks=False)


def test_a_summarized_row_is_created_in_tasks_from_its_frozen_request(worker: Worker) -> None:
    event_id, frozen = frozen_row(worker, "summarized")
    event = worker.wait_event(event_id, {"complete"})
    [task] = [task for task in tasks.created(worker) if event_id in task["description"]]
    assert (task["title"], task["description"], task["project_id"]) == (frozen["title"], frozen["description"], "")
    assert request_id(frozen["request_id"]) in tasks.request_ids(worker)
    assert event["task_id"] == task["id"]
    assert ("summarized", "todo_sending", None, "worker") in transitions(event)
    [summary] = worker.d1(f"SELECT task_id FROM summaries WHERE event_id = '{event_id}'")
    assert summary["task_id"] == task["id"]


@pytest.mark.reaches("todoist_rejected")
def test_a_create_tasks_refuses_waits_in_summarized(launch: Launch) -> None:
    worker = launch(TODOIST_DEFAULT_PROJECT_ID="missing-project")
    event_id, _ = frozen_row(worker, "summarized")
    event = worker.wait_event(event_id, lambda e: e["error_code"] == "todoist_rejected")
    assert event["state"] == "summarized" and event["allowed_actions"] == ["dismiss"]
    assert tasks.created(worker) == []


@pytest.mark.reaches("lookup_not_found", "lookup_ambiguous")
def test_the_footer_lookup_counts_the_tasks_that_carry_the_footer(worker: Worker) -> None:
    missing, _ = frozen_row(worker, "todo_unknown", last_error_code="todo_result_unknown")
    assert worker.wait_event(missing, lambda e: e["error_code"] == "lookup_not_found")["state"] == "todo_unknown"

    event_id, body = mail_event()
    tasks.seed(
        worker,
        *({"title": "Twice", "description": f"copy {n}\n\n{FOOTER_PREFIX}{event_id}"} for n in range(2)),
        now=int(time.time()),
    )
    now = int(time.time())
    twice = event_row(
        event_id,
        "todo_unknown",
        now - 3600,
        payload=body.decode(),
        payload_hash=sha256_hex(body),
        summary="Frozen summary",
        summary_model="older-model",
        todo_body="Frozen",
        todoist_request_id=f"todofy-{uuid.uuid4().hex[:28]}",
        last_error_code="todo_result_unknown",
        next_attempt_at=now - 1,
    )
    seed(worker, "mail_events", [twice])
    assert worker.trigger_cron().status_code == 200
    ambiguous = worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_ambiguous")
    assert ambiguous["state"] == "todo_unknown" and ambiguous["task_id"] is None


@pytest.mark.reaches("todoist_unavailable", "lookup_failed")
def test_without_the_tasks_binding_a_create_waits_and_a_lookup_fails(unbound: Worker) -> None:
    waiting, _ = frozen_row(unbound, "summarized")
    event = unbound.wait_event(waiting, lambda e: e["error_code"] == "todoist_unavailable")
    assert event["state"] == "summarized" and event["next_attempt_time"] is not None
    unknown, _ = frozen_row(unbound, "todo_unknown", last_error_code="todo_result_unknown")
    assert unbound.wait_event(unknown, lambda e: e["error_code"] == "lookup_failed")["state"] == "todo_unknown"
