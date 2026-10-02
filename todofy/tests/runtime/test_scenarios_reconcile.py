"""The four owner reconcile actions end to end, with idempotency and conflicts (v2 plan §5.3, §5.4)."""

import uuid

import pytest

from tests.fakes.gemini_fake import GeminiFake, error_reply
from tests.fakes.server import Reply
from tests.fakes.todoist_fake import TASKS_PATH, TodoistFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, reason, transitions
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
    worker.wait_event(event_id, lambda e: e.get("error_code") == "lookup_not_found")
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
    assert (event["state"], event["error_code"], event.get("attention"), event.get("allowed_actions")) == (
        "ignored",
        "dismissed_by_owner",
        None,
        None,
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


@pytest.mark.reaches("ETAG_MISMATCH", "ACTION_NOT_ALLOWED", "NOT_FOUND")
def test_replays_and_conflicts(worker: Worker, fresh_todoist: TodoistFake) -> None:
    event_id = _unknown(worker, fresh_todoist)
    etag = worker.event(event_id)["etag"]
    request_id = str(uuid.uuid4())

    first = worker.reconcile(event_id, "dismiss", etag=etag, request_id=request_id)
    replay = worker.reconcile(event_id, "dismiss", etag=etag, request_id=request_id)
    assert (first.status_code, replay.status_code) == (200, 200)
    assert (replay.json()["state"], replay.json()["etag"]) == (first.json()["state"], first.json()["etag"])

    reused = worker.reconcile(event_id, "task_created", etag=etag, task_id="1", request_id=request_id)
    assert (reused.status_code, reason(reused)) == (400, "BAD_REQUEST")  # the request_id was used for another
    stale = worker.reconcile(event_id, "dismiss", etag=etag)
    assert (stale.status_code, reason(stale)) == (409, "ETAG_MISMATCH")
    not_allowed = worker.reconcile(event_id, "retry_summary")
    assert (not_allowed.status_code, reason(not_allowed)) == (400, "ACTION_NOT_ALLOWED")
    missing = worker.reconcile(str(uuid.uuid4()), "dismiss", etag="1")
    assert (missing.status_code, reason(missing)) == (404, "NOT_FOUND")


def test_review_flagged_mail_cannot_be_retried(worker: Worker) -> None:
    event_id = _arrive(worker, needs_review=True)
    worker.wait_event(event_id, {"failed_summary"})

    response = worker.reconcile(event_id, "retry_summary")

    assert (response.status_code, reason(response)) == (400, "ACTION_NOT_ALLOWED")


@pytest.mark.reaches("BAD_REQUEST")
@pytest.mark.parametrize(
    "body",
    [
        {"action": "task_created", "etag": "1"},
        {"action": "dismiss", "etag": "1", "task_id": "1"},
        {"action": "dismiss"},
        {"action": "explode", "etag": "1"},
        {"action": "dismiss", "etag": "1", "extra": True},
    ],
    ids=["task_id_missing", "task_id_not_allowed", "etag_missing", "unknown_action", "extra_field"],
)
def test_invalid_reconcile_bodies_are_bad_requests(worker: Worker, body: dict) -> None:
    event_id = _arrive(worker)
    response = worker.post_owner(f"/api/v1/mailEvents/{event_id}:reconcile", body | {"request_id": str(uuid.uuid4())})
    assert (response.status_code, reason(response)) == (400, "BAD_REQUEST")


@pytest.mark.reaches("CSRF_FAILED")
def test_mutations_need_the_same_origin_and_the_csrf_token(worker: Worker) -> None:
    event_id = _arrive(worker)
    good = worker.csrf_headers()
    # No body: CSRF is checked before the body is read, and an unread upload makes wrangler's
    # local proxy drop the next POST on this dev server (see docs/dev-notes.md).
    for headers in (
        {},
        good | {"origin": "https://evil.example"},
        {k: v for k, v in good.items() if k != "x-csrf-token"},
        good | {"cookie": "todofy_csrf=other"},
    ):
        response = worker.owner.post(f"/api/v1/mailEvents/{event_id}:reconcile", headers=headers)
        assert (response.status_code, reason(response)) == (403, "CSRF_FAILED"), headers
