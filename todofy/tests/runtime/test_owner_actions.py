"""Owner routes served by the coordinator: event detail, reconcile idempotency and
report recompute, end to end through the Worker gate. Processing is paused so
the only writer of the seeded rows is the owner.
"""

import hashlib
import json
import time
import uuid
from collections.abc import Iterator

import httpx
import pytest

from tests.runtime.harness import Worker, start_gateway
from tests.runtime.owner_support import (
    CSRF_KEY,
    assert_contract,
    assert_private,
    error_code,
    event_row,
    issue_csrf,
    seed,
)

NOW = int(time.time())
UNKNOWN = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e720001"
FAILED = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e720002"
DETAIL = "/api/v1/events/{event_id}"
RECONCILE = "/api/v1/events/{event_id}/reconcile"


def _payload(event_id: str) -> str:
    return json.dumps(
        {
            "type": "mail.received.v1",
            "event_id": event_id,
            "received_at": "2026-09-23T16:00:00Z",
            "message": {
                "id": str(uuid.uuid4()),
                "from": [{"address": "sender@example.org", "name": "Sender"}],
                "to": [{"address": "owner@example.org", "name": "Owner"}],
                "subject": "Synthetic reconcile fixture",
                "sent_at": "2026-09-23T08:30:15-07:00",
                "rfc_message_id": None,
                "text": "Synthetic mail body",
                "attachments": [],
            },
        },
        separators=(",", ":"),
    )


def _row(event_id: str, state: str, code: str) -> dict[str, object]:
    payload = _payload(event_id)
    return event_row(
        event_id,
        state,
        NOW - 600,
        payload=payload,
        payload_hash=hashlib.sha256(payload.encode()).hexdigest(),
        last_error_code=code,
    )


@pytest.fixture(scope="module")
def actions_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    for worker in start_gateway(
        tmp_path_factory.mktemp("owner-actions-worker"),
        {"CSRF_SIGNING_KEY": CSRF_KEY, "PROCESSING_PAUSED": "true"},
    ):
        seed(
            worker,
            "mail_events",
            [_row(UNKNOWN, "todo_unknown", "todo_result_unknown"), _row(FAILED, "failed_summary", "summary_failed")],
        )
        yield worker


def _post(worker: Worker, path: str, body: dict[str, object]) -> httpx.Response:
    headers = issue_csrf(worker.owner) | {"content-type": "application/json"}
    return worker.owner.post(path, headers=headers, content=json.dumps(body).encode())


def test_event_detail_is_served_by_the_coordinator(actions_worker: Worker) -> None:
    response = actions_worker.owner.get(f"/api/v1/events/{UNKNOWN}")
    assert response.status_code == 200, response.text
    detail = assert_contract(response, DETAIL)
    assert (detail["state"], detail["version"]) == ("todo_unknown", 1)
    assert detail["allowed_actions"] == ["task_created", "task_not_created", "dismiss"]
    assert_private(response)


def test_reconcile_replays_the_stored_outcome_and_rejects_reuse(actions_worker: Worker) -> None:
    path = f"/api/v1/events/{UNKNOWN}/reconcile"
    request = {"action": "dismiss", "version": 1, "action_request_id": str(uuid.uuid4())}
    first = _post(actions_worker, path, request)
    assert first.status_code == 200, first.text
    detail = assert_contract(first, RECONCILE, "post")
    assert (detail["state"], detail["version"], detail["allowed_actions"]) == ("ignored", 2, [])
    assert detail["transitions"][-1]["actor"] == "owner"

    replay = _post(actions_worker, path, request)
    assert (replay.status_code, replay.json()) == (200, detail)

    reused = _post(actions_worker, path, request | {"action": "task_created", "task_id": "123"})
    assert (reused.status_code, error_code(reused)) == (409, "action_request_conflict")
    assert_contract(reused, RECONCILE, "post")

    stale = _post(actions_worker, path, request | {"action_request_id": str(uuid.uuid4())})
    assert (stale.status_code, error_code(stale)) == (409, "version_conflict")

    not_allowed = _post(actions_worker, path, request | {"version": 2, "action_request_id": str(uuid.uuid4())})
    assert (not_allowed.status_code, error_code(not_allowed)) == (409, "action_not_allowed")


def test_reconcile_of_an_unknown_event_is_404(actions_worker: Worker) -> None:
    missing = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e72ffff"
    request = {"action": "dismiss", "version": 1, "action_request_id": str(uuid.uuid4())}
    response = _post(actions_worker, f"/api/v1/events/{missing}/reconcile", request)
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert_contract(response, RECONCILE, "post")


def test_retry_summary_moves_a_failed_summary_back_to_pending(actions_worker: Worker) -> None:
    request = {"action": "retry_summary", "version": 1, "action_request_id": str(uuid.uuid4())}
    response = _post(actions_worker, f"/api/v1/events/{FAILED}/reconcile", request)
    assert response.status_code == 200, response.text
    assert assert_contract(response, RECONCILE, "post")["state"] == "pending"


@pytest.mark.parametrize(("kind", "top_n"), [("summary", None), ("recommendation", 10)])
def test_recompute_with_an_empty_window_needs_no_model(actions_worker: Worker, kind: str, top_n: int | None) -> None:
    response = _post(
        actions_worker, "/api/v1/reports/recompute", {"kind": kind, "action_request_id": str(uuid.uuid4())}
    )
    assert response.status_code == 200, response.text
    report = assert_contract(response, "/api/v1/reports/recompute", "post")
    assert report["status"] == "empty_window"
    if top_n is not None:
        assert report["top_n"] == top_n  # the REPORT_DEFAULT_TOP default
