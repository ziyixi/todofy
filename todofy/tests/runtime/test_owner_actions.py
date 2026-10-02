"""Owner routes served by the coordinator: event detail, reconcile idempotency and
report recompute, end to end through the Worker gate. Processing is paused so
the only writer of the seeded rows is the owner.
"""

import hashlib
import json
import time
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from ziyixi_proto.todofy.ui.v1 import mail_event_pb
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

from tests.runtime.harness import Worker, start_gateway
from tests.runtime.owner_support import (
    CSRF_KEY,
    assert_message,
    assert_private,
    assert_status,
    event_row,
    issue_csrf,
    seed,
)

NOW = int(time.time())
UNKNOWN = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e720001"
FAILED = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e720002"
MAIL_EVENT_DETAIL = "type.googleapis.com/todofy.ui.v1.MailEvent"


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


def _reconcile(event_id: str) -> str:
    return f"/api/v1/mailEvents/{event_id}:reconcile"


def _detail(error: dict[str, Any]) -> dict[str, Any]:
    """The current MailEvent a refused reconcile carries."""
    [event] = [detail for detail in error["details"] if detail["@type"] == MAIL_EVENT_DETAIL]
    return event


def test_event_detail_is_served_by_the_coordinator(actions_worker: Worker) -> None:
    response = actions_worker.owner.get(f"/api/v1/mailEvents/{UNKNOWN}")
    detail = assert_message(response, mail_event_pb.MailEvent)
    assert (detail["state"], detail["version"], detail["etag"]) == ("todo_unknown", 1, "1")
    assert detail["allowed_actions"] == ["task_created", "task_not_created", "dismiss"]
    assert detail["sender"] == "sender@example.org" and detail["subject"] == "Synthetic reconcile fixture"
    assert_private(response)


def test_reconcile_replays_the_stored_outcome_and_rejects_reuse(actions_worker: Worker) -> None:
    path = _reconcile(UNKNOWN)
    request = {"action": "dismiss", "etag": "1", "request_id": str(uuid.uuid4())}
    first = _post(actions_worker, path, request)
    detail = assert_message(first, mail_event_pb.MailEvent)
    assert (detail["state"], detail["version"], detail["etag"], "allowed_actions" in detail) == (
        "ignored",
        2,
        "2",
        False,
    )
    assert detail["transitions"][-1]["actor"] == "owner"

    replay = _post(actions_worker, path, request)
    assert (replay.status_code, replay.json()) == (200, detail)

    reused = _post(actions_worker, path, request | {"action": "task_created", "task_id": "123"})
    assert_status(reused, 400, "REQUEST_ID_REUSED")

    stale = _post(actions_worker, path, request | {"request_id": str(uuid.uuid4())})
    current = _detail(assert_status(stale, 409, "ETAG_MISMATCH"))
    assert (current["name"], current["etag"], current["state"]) == (f"mailEvents/{UNKNOWN}", "2", "ignored")
    malformed = _post(actions_worker, path, request | {"etag": "v1", "request_id": str(uuid.uuid4())})
    assert _detail(assert_status(malformed, 409, "ETAG_MISMATCH"))["etag"] == "2"

    not_allowed = _post(actions_worker, path, request | {"etag": "2", "request_id": str(uuid.uuid4())})
    assert _detail(assert_status(not_allowed, 400, "ACTION_NOT_ALLOWED"))["state"] == "ignored"


def test_reconcile_of_an_unknown_event_is_not_found(actions_worker: Worker) -> None:
    missing = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e72ffff"
    request = {"action": "dismiss", "etag": "1", "request_id": str(uuid.uuid4())}
    assert_status(_post(actions_worker, _reconcile(missing), request), 404, "NOT_FOUND")
    stale = _post(actions_worker, _reconcile(missing), request | {"etag": "x"})
    assert_status(stale, 404, "NOT_FOUND")


def test_retry_summary_moves_a_failed_summary_back_to_pending(actions_worker: Worker) -> None:
    request = {"action": "retry_summary", "etag": "1", "request_id": str(uuid.uuid4())}
    response = _post(actions_worker, _reconcile(FAILED), request)
    assert assert_message(response, mail_event_pb.MailEvent)["state"] == "pending"


@pytest.mark.parametrize(("kind", "top_n"), [("summary", None), ("recommendation", 10)])
def test_recompute_with_an_empty_window_needs_no_model(actions_worker: Worker, kind: str, top_n: int | None) -> None:
    response = _post(actions_worker, "/api/v1/latestReports:recompute", {"kind": kind, "request_id": str(uuid.uuid4())})
    answer = assert_message(response, pb.RecomputeReportResponse)
    [(field, report)] = answer.items()
    assert field == kind and report["status"] == "empty_window"
    if top_n is not None:
        assert report["top_n"] == top_n  # the REPORT_DEFAULT_TOP default
