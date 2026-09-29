"""The four owner reconcile actions end to end, with idempotency and conflicts (v2 plan §5.3, §5.4)."""

import uuid

import pytest

from tests.fakes.gemini_fake import GeminiFake, error_reply
from tests.fakes.server import Reply
from tests.fakes.todoist_fake import TASKS_PATH, TodoistFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, error_code, mail_event, transitions
from todofy.core.backoff import SUMMARY_GIVE_UP_ATTEMPTS
from todofy.core.render import FOOTER_PREFIX


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    # Backoff rounds up to whole seconds, so twelve failed summaries take about half a minute.
    return launch(BACKOFF_BASE_MS="1")


def _arrive(worker: Worker, **fields: object) -> str:
    event_id, body = mail_event(**fields)
    assert worker.post_event(body).status_code == 204
    return event_id


def _unknown(worker: Worker, todoist: TodoistFake) -> str:
    """An event whose task creation failed with 500 and whose lookup found nothing."""
    todoist.queue("POST", TASKS_PATH, Reply(500, "boom"))
    event_id = _arrive(worker)
    worker.wait_event(event_id, lambda e: e["error_code"] == "lookup_not_found")
    return event_id


def _owner_step(event: dict, to_state: str) -> tuple:
    [step] = [t for t in transitions(event) if t[1] == to_state and t[3] == "owner"]
    return step


@pytest.mark.reaches("dismissed_by_owner")
def test_dismiss_ignores_the_event_without_calling_todoist(worker: Worker, fresh_todoist: TodoistFake) -> None:
    event_id = _unknown(worker, fresh_todoist)
    lookups = len(fresh_todoist.lists())

    response = worker.reconcile(event_id, "dismiss")

    assert response.status_code == 200, response.text
    event = response.json()
    assert (event["state"], event["error_code"], event["attention"], event["allowed_actions"]) == (
        "ignored",
        "dismissed_by_owner",
        False,
        [],
    )
    assert _owner_step(event, "ignored") == ("todo_unknown", "ignored", "dismissed_by_owner", "owner")
    [row] = worker.d1(f"SELECT payload IS NULL AS dropped FROM mail_events WHERE event_id = '{event_id}'")
    assert row["dropped"] == 1
    assert len(fresh_todoist.creates_for(event_id)) == 1 and len(fresh_todoist.lists()) == lookups


def test_task_created_completes_with_the_owner_task_id(worker: Worker, fresh_todoist: TodoistFake) -> None:
    event_id = _unknown(worker, fresh_todoist)

    response = worker.reconcile(event_id, "task_created", task_id="6Xowner0001")

    assert response.status_code == 200, response.text
    committed = response.json()
    assert ("todo_unknown", committed["state"], None, "owner") in transitions(committed)
    event = worker.wait_event(event_id, {"complete"})
    assert event["task_id"] == "6Xowner0001"
    [row] = worker.d1(f"SELECT task_id FROM summaries WHERE event_id = '{event_id}'")
    assert row["task_id"] == "6Xowner0001"
    assert len(fresh_todoist.creates_for(event_id)) == 1


def test_task_not_created_looks_up_first_then_resends_the_frozen_request(
    worker: Worker, fresh_todoist: TodoistFake
) -> None:
    event_id = _unknown(worker, fresh_todoist)
    lookups = len(fresh_todoist.lists())

    assert worker.reconcile(event_id, "task_not_created").status_code == 200
    event = worker.wait_event(event_id, {"complete"})

    first, resent = fresh_todoist.creates_for(event_id)
    assert (first.body, first.headers["x-request-id"]) == (resent.body, resent.headers["x-request-id"])
    assert any(first.at < lookup.at < resent.at for lookup in fresh_todoist.lists()[lookups:])
    assert event["task_id"] == fresh_todoist.tasks[-1].id


def test_task_not_created_does_not_resend_when_the_lookup_now_finds_the_task(
    worker: Worker, fresh_todoist: TodoistFake
) -> None:
    event_id = _unknown(worker, fresh_todoist)
    found = fresh_todoist.add_task("made by hand", f"body\n\n{FOOTER_PREFIX}{event_id}")

    assert worker.reconcile(event_id, "task_not_created").status_code == 200
    event = worker.wait_event(event_id, {"complete"})

    assert event["task_id"] == found.id
    assert len(fresh_todoist.creates_for(event_id)) == 1


def test_retry_summary_after_the_worker_gave_up(worker: Worker, fresh_gemini: GeminiFake) -> None:
    for _ in range(SUMMARY_GIVE_UP_ATTEMPTS + 1):
        fresh_gemini.queue_generate(error_reply(400), model="model-a")
    event_id = _arrive(worker)

    failed = worker.wait_event(event_id, {"failed_summary"}, timeout_s=120)
    assert (failed["error_code"], failed["attention"]) == ("llm_request_rejected", True)
    assert failed["allowed_actions"] == ["retry_summary", "dismiss"]
    fresh_gemini.reset()

    response = worker.reconcile(event_id, "retry_summary")

    assert response.status_code == 200, response.text
    assert _owner_step(response.json(), "pending") == ("failed_summary", "pending", None, "owner")
    worker.wait_event(event_id, {"complete"})
    assert len(fresh_gemini.calls_mentioning(event_id)) == 1


@pytest.mark.reaches("action_request_conflict", "version_conflict", "action_not_allowed", "not_found")
def test_replays_and_conflicts(worker: Worker, fresh_todoist: TodoistFake) -> None:
    event_id = _unknown(worker, fresh_todoist)
    version = worker.event(event_id)["version"]
    action_id = str(uuid.uuid4())

    first = worker.reconcile(event_id, "dismiss", version=version, action_request_id=action_id)
    replay = worker.reconcile(event_id, "dismiss", version=version, action_request_id=action_id)
    assert (first.status_code, replay.status_code) == (200, 200)
    assert (replay.json()["state"], replay.json()["version"]) == (first.json()["state"], first.json()["version"])

    reused = worker.reconcile(event_id, "task_created", version=version, task_id="1", action_request_id=action_id)
    assert (reused.status_code, error_code(reused)) == (409, "action_request_conflict")
    stale = worker.reconcile(event_id, "dismiss", version=version)
    assert (stale.status_code, error_code(stale)) == (409, "version_conflict")
    not_allowed = worker.reconcile(event_id, "retry_summary")
    assert (not_allowed.status_code, error_code(not_allowed)) == (409, "action_not_allowed")
    missing = worker.reconcile(str(uuid.uuid4()), "dismiss", version=1)
    assert (missing.status_code, error_code(missing)) == (404, "not_found")


def test_review_flagged_mail_cannot_be_retried(worker: Worker) -> None:
    event_id = _arrive(worker, needs_review=True)
    worker.wait_event(event_id, {"failed_summary"})

    response = worker.reconcile(event_id, "retry_summary")

    assert (response.status_code, error_code(response)) == (409, "action_not_allowed")


@pytest.mark.reaches("invalid_request")
@pytest.mark.parametrize(
    "body",
    [
        {"action": "task_created", "version": 1},
        {"action": "dismiss", "version": 1, "task_id": "1"},
        {"action": "dismiss", "version": 0},
        {"action": "explode", "version": 1},
        {"action": "dismiss", "version": 1, "extra": True},
    ],
    ids=["task_id_missing", "task_id_not_allowed", "version_zero", "unknown_action", "extra_field"],
)
def test_invalid_reconcile_bodies_are_400(worker: Worker, body: dict) -> None:
    event_id = _arrive(worker)
    response = worker.post_owner(
        f"/api/v1/events/{event_id}/reconcile", body | {"action_request_id": str(uuid.uuid4())}
    )
    assert (response.status_code, error_code(response)) == (400, "invalid_request")


@pytest.mark.reaches("csrf_failed")
def test_mutations_need_the_same_origin_and_the_csrf_token(worker: Worker) -> None:
    event_id = _arrive(worker)
    body = {"action": "dismiss", "version": 1, "action_request_id": str(uuid.uuid4())}
    good = worker.csrf_headers()
    for headers in (
        {},
        good | {"origin": "https://evil.example"},
        {k: v for k, v in good.items() if k != "x-csrf-token"},
        good | {"cookie": "todofy_csrf=other"},
    ):
        response = worker.owner.post(f"/api/v1/events/{event_id}/reconcile", json=body, headers=headers)
        assert (response.status_code, error_code(response)) == (403, "csrf_failed"), headers
