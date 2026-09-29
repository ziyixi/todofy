"""Mail Hero → Todofy delivery semantics: token rotation, the contract, idempotency and dedupe."""

import json
import time

import pytest

from tests import mail_contract
from tests.fakes.gemini_fake import GeminiFake
from tests.runtime.harness import PREVIOUS_WEBHOOK_TOKEN, WEBHOOK_TOKEN, Worker, error_code, mail_event, sha256_hex

FIXTURES = mail_contract.fixtures()


def test_the_current_and_previous_token_both_deliver_to_one_ledger_row(worker: Worker) -> None:
    event_id, body = mail_event()

    assert worker.post_event(body, token=PREVIOUS_WEBHOOK_TOKEN).status_code == 204
    assert worker.post_event(body, token=WEBHOOK_TOKEN).status_code == 204

    arrivals = [t for t in worker.wait_event(event_id, {"complete"})["transitions"] if t["from_state"] is None]
    assert len(arrivals) == 1
    _, changed = mail_event(event_id, subject="changed")
    conflict = worker.post_event(changed, token=PREVIOUS_WEBHOOK_TOKEN)
    assert (conflict.status_code, error_code(conflict)) == (409, "event_conflict")


@pytest.mark.reaches("invalid_payload")
@pytest.mark.parametrize(
    "key",
    [None, "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e71ffff", "{id}, {id}"],
    ids=["missing", "different", "repeated"],
)
def test_the_idempotency_key_must_be_the_event_id(worker: Worker, key: str | None) -> None:
    event_id, body = mail_event()
    headers = {"authorization": f"Bearer {WEBHOOK_TOKEN}", "content-type": "application/json"}
    if key is not None:
        headers["idempotency-key"] = key.format(id=event_id)

    response = worker.hooks.post("/hooks/mail", content=body, headers=headers)

    assert (response.status_code, error_code(response)) == (400, "invalid_payload")
    assert worker.event(event_id) is None


def _broken(change: str) -> tuple[str, bytes]:
    event_id, body = mail_event()
    document = json.loads(body)
    match change:
        case "type":
            document["type"] = "mail.received.v2"
        case "received_at_offset":
            document["received_at"] = "2026-09-28T08:00:00+02:00"
        case "event_id":
            document["event_id"] = "not-a-uuid"
        case "missing_attachments":
            del document["message"]["attachments"]
        case "empty":
            document["message"] |= {"subject": " ", "text": "\n"}
        case "text_too_long":
            document["message"]["text"] = "x" * (256 * 1024 + 1)
        case "truncated_without_size":
            document["message"]["text_truncated"] = True
        case "null_warnings":
            document["message"]["warnings"] = None
    return event_id, json.dumps(document).encode()


@pytest.mark.parametrize(
    "change",
    [
        "type",
        "received_at_offset",
        "event_id",
        "missing_attachments",
        "empty",
        "text_too_long",
        "truncated_without_size",
        "null_warnings",
    ],
)
def test_contract_violations_are_rejected_and_not_stored(worker: Worker, change: str) -> None:
    event_id, body = _broken(change)

    response = worker.post_event(body, event_id)

    assert (response.status_code, error_code(response)) == (400, "invalid_payload")
    if change != "event_id":
        assert worker.event(event_id) is None


@pytest.mark.parametrize("name", FIXTURES)
def test_every_shape_mail_hero_emits_is_accepted(worker: Worker, name: str) -> None:
    body = FIXTURES[name].read_bytes()

    response = worker.post_event(body)

    assert response.status_code == 204, response.text
    assert worker.post_event(body).status_code == 204


def test_a_replay_of_an_imported_row_is_acknowledged_without_new_work(worker: Worker, gemini: GeminiFake) -> None:
    event_id, body = mail_event()
    old = int(time.time()) - 30 * 86400
    worker.d1(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, task_id, imported,"
        f" created_at, updated_at) VALUES ('mail-hero-personal', '{event_id}', '{sha256_hex(body)}', NULL,"
        f" 'complete', '6Ximported', 1, {old}, {old})"
    )

    assert worker.post_event(body).status_code == 204
    _, changed = mail_event(event_id, subject="changed")
    assert worker.post_event(changed).status_code == 409

    time.sleep(2)
    event = worker.event(event_id)
    assert (event["state"], event["imported"], event["task_id"]) == ("complete", True, "6Ximported")
    assert gemini.calls_mentioning(event_id) == []


def test_the_source_id_scopes_the_ledger(worker: Worker) -> None:
    """Rows from another source never answer for this one (the dedupe key is (source_id, event_id))."""
    event_id, body = mail_event()
    worker.d1(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, state, created_at, updated_at)"
        f" VALUES ('another-source', '{event_id}', '{'0' * 64}', 'ignored', 0, 0)"
    )

    assert worker.post_event(body).status_code == 204
    assert worker.wait_event(event_id, {"complete"})["imported"] is False
