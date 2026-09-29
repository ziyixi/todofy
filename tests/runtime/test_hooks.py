import hashlib

from tests.runtime.harness import AUTH, Worker, error_code, event_body, spike_event

MIB = 1 << 20


def test_one_mebibyte_event_is_hashed_and_stored_in_one_batch(worker: Worker) -> None:
    event_id, body = event_body(size=MIB)

    response = worker.hooks.post("/hooks/mail", content=body, headers=AUTH)

    assert response.status_code == 204, response.text
    row = spike_event(worker.owner, event_id)
    assert row["body_sha256"] == hashlib.sha256(body).hexdigest()
    assert row["body_bytes"] == MIB


def test_same_bytes_are_idempotent_and_different_bytes_conflict(worker: Worker) -> None:
    event_id, body = event_body(subject="first")
    _, changed = event_body(event_id=event_id, subject="second")

    assert worker.hooks.post("/hooks/mail", content=body, headers=AUTH).status_code == 204
    assert worker.hooks.post("/hooks/mail", content=body, headers=AUTH).status_code == 204
    conflict = worker.hooks.post("/hooks/mail", content=changed, headers=AUTH)
    assert (conflict.status_code, error_code(conflict)) == (409, "event_conflict")


def test_webhook_rejects_bad_credentials_and_media_types(worker: Worker) -> None:
    # Bodiless: the Worker answers these without reading the body, and wrangler's
    # local proxy can drop the next POST if an unread upload is still in flight.
    for headers in (
        {"content-type": "application/json"},
        {**AUTH, "authorization": "Bearer wrong-token"},
        {**AUTH, "authorization": AUTH["authorization"].replace("Bearer", "Basic")},
    ):
        assert worker.hooks.post("/hooks/mail", headers=headers).status_code == 401
    assert worker.hooks.post("/hooks/mail", headers=AUTH | {"content-type": "text/plain"}).status_code == 415
    assert worker.hooks.post("/hooks/mail", content=b"not json", headers=AUTH).status_code == 400


def test_webhook_without_a_configured_digest_is_unavailable(auth_worker: Worker) -> None:
    response = auth_worker.hooks.post("/hooks/mail", headers=AUTH)
    assert (response.status_code, error_code(response)) == (503, "not_configured")
