"""The owner reconcile actions end to end, with idempotency and conflicts (v2 plan §5.3, §5.4).

Retry a failed summary, or dismiss a row that needs the owner. The task actions (task_created,
task_not_created) answered a task create whose outcome was lost; Todofy writes no task since
2026-10-21, so no row can offer them and a request for one is ACTION_NOT_ALLOWED."""

import time
import uuid

import pytest

from tests.fakes.model_router_fake import ModelRouterFake, error_reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, reason, sha256_hex, transitions
from tests.runtime.owner_support import event_row, seed
from todofy.core.backoff import SUMMARY_GIVE_UP_ATTEMPTS


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    # Backoff rounds up to whole seconds, so twelve failed summaries take about half a minute.
    return launch(BACKOFF_BASE_MS="1")


def _arrive(worker: Worker, **fields: object) -> str:
    event_id, body = mail_event(**fields)
    assert worker.post_event(body).status_code == 204
    return event_id


def _failed(worker: Worker) -> str:
    """An event whose summary the worker gave up on: it needs the owner."""
    event_id, body = mail_event()
    seed(
        worker,
        "mail_events",
        [
            event_row(
                event_id,
                "failed_summary",
                int(time.time()) - 3600,
                payload=body.decode(),
                payload_hash=sha256_hex(body),
                last_error_code="summary_failed",
                attempt_count=12,
            )
        ],
    )
    return event_id


def _owner_step(event: dict, to_state: str) -> tuple:
    [step] = [t for t in transitions(event) if t[1] == to_state and t[3] == "owner"]
    return step


@pytest.mark.reaches("dismissed_by_owner")
def test_dismiss_ignores_the_event(worker: Worker) -> None:
    event_id = _failed(worker)

    response = worker.reconcile(event_id, "dismiss")

    assert response.status_code == 200, response.text
    event = response.json()
    assert (event["state"], event["error_code"], event.get("attention"), event.get("allowed_actions")) == (
        "ignored",
        "dismissed_by_owner",
        None,
        None,
    )
    assert _owner_step(event, "ignored") == ("failed_summary", "ignored", "dismissed_by_owner", "owner")
    [row] = worker.d1(f"SELECT payload IS NULL AS dropped FROM mail_events WHERE event_id = '{event_id}'")
    assert row["dropped"] == 1


def test_the_task_actions_are_not_offered(worker: Worker) -> None:
    event_id = _failed(worker)
    assert worker.event(event_id)["allowed_actions"] == ["retry_summary", "dismiss"]
    for action, task_id in (("task_created", "6Xowner0001"), ("task_not_created", None)):
        refused = worker.reconcile(event_id, action, task_id=task_id)
        assert (refused.status_code, reason(refused)) == (400, "ACTION_NOT_ALLOWED"), action
    assert worker.event(event_id)["state"] == "failed_summary"


def test_retry_summary_after_the_worker_gave_up(worker: Worker, fresh_gemini: ModelRouterFake) -> None:
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
def test_replays_and_conflicts(worker: Worker) -> None:
    event_id = _failed(worker)
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
