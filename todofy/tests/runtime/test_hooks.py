"""POST /hooks/mail: authentication, media type, size and the ledger commit."""

import pytest

from tests.runtime.conftest import Launch
from tests.runtime.harness import AUTH, Worker, error_code, mail_event, sha256_hex

MIB = 1 << 20


def test_one_mebibyte_event_is_hashed_and_stored(launch: Launch) -> None:
    # Paused: otherwise the alarm may finish the event, which clears its payload, before the read.
    worker = launch(PROCESSING_PAUSED="true")
    event_id, body = mail_event(size=MIB)

    response = worker.post_event(body)

    assert response.status_code == 204, response.text
    [row] = worker.d1(
        "SELECT state, payload_hash, length(CAST(payload AS BLOB)) AS size"
        f" FROM mail_events WHERE event_id = '{event_id}'"
    )
    assert row == {"state": "pending", "payload_hash": sha256_hex(body), "size": MIB}


@pytest.mark.reaches("event_conflict")
def test_same_bytes_are_idempotent_and_different_bytes_conflict(worker: Worker) -> None:
    event_id, body = mail_event(subject="first")
    _, changed = mail_event(event_id, subject="second")

    assert worker.post_event(body).status_code == 204
    assert worker.post_event(body).status_code == 204
    conflict = worker.post_event(changed)
    assert (conflict.status_code, error_code(conflict)) == (409, "event_conflict")
    arrivals = [t for t in worker.event(event_id)["transitions"] if t["from_state"] is None]
    assert len(arrivals) == 1


@pytest.mark.reaches("unauthorized", "unsupported_media_type", "invalid_payload")
def test_webhook_rejects_bad_credentials_and_media_types(worker: Worker) -> None:
    # Bodiless: the Worker answers these without reading the body, and wrangler's
    # local proxy can drop the next POST if an unread upload is still in flight.
    for headers in (
        {"content-type": "application/json"},
        {**AUTH, "authorization": "Bearer wrong-token"},
        {**AUTH, "authorization": AUTH["authorization"].replace("Bearer", "Basic")},
        {**AUTH, "authorization": AUTH["authorization"] + " extra"},
    ):
        response = worker.hooks.post("/hooks/mail", headers=headers)
        assert (response.status_code, error_code(response)) == (401, "unauthorized"), headers
    response = worker.hooks.post("/hooks/mail", headers=AUTH | {"content-type": "text/plain"})
    assert (response.status_code, error_code(response)) == (415, "unsupported_media_type")
    not_json = worker.post_event(b"not json", "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001")
    assert (not_json.status_code, error_code(not_json)) == (400, "invalid_payload")


def test_a_body_without_content_length_is_accepted(worker: Worker) -> None:
    event_id, body = mail_event()
    headers = {"idempotency-key": event_id}
    response = worker.hooks.post("/hooks/mail", content=iter([body[:100], body[100:]]), headers=AUTH | headers)
    assert response.status_code == 204, response.text
    assert worker.event(event_id) is not None


@pytest.mark.reaches("not_configured")
def test_webhook_without_a_configured_digest_is_unavailable(auth_worker: Worker) -> None:
    response = auth_worker.hooks.post("/hooks/mail", headers=AUTH)
    assert (response.status_code, error_code(response)) == (503, "not_configured")
