"""The owner surface after real traffic: imported legacy rows, contract-valid reads and Access identity."""

import time
import uuid

import pytest

from tests.runtime.conftest import Launch
from tests.runtime.harness import OWNER, AccessIssuer, Worker, error_code, mail_event
from tests.runtime.owner_support import assert_contract
from todofy.core.vocab import EVENT_ERROR_CODES, REMINDER_ERROR_CODES

LEGACY_EVENT_CODES = [code for code, info in EVENT_ERROR_CODES.items() if info.legacy]
LEGACY_REMINDER_CODES = [code for code, info in REMINDER_ERROR_CODES.items() if info.legacy]
ALIAS = "owner.alias@example.net"


@pytest.mark.reaches(*LEGACY_EVENT_CODES, *LEGACY_REMINDER_CODES)
def test_imported_rows_keep_their_go_error_codes(worker: Worker) -> None:
    old = int(time.time()) - 40 * 86400
    ids = {code: str(uuid.uuid4()) for code in LEGACY_EVENT_CODES}
    rows = ", ".join(
        f"('mail-hero-personal', '{event_id}', '{'0' * 64}', NULL, 'ignored', '{code}', 1, {old}, {old})"
        for code, event_id in ids.items()
    )
    reminders = ", ".join(
        f"('2026-0{n + 1}-01', 'failed', '{code}', 1, 1, {old}, {old})" for n, code in enumerate(LEGACY_REMINDER_CODES)
    )
    worker.d1(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, last_error_code, imported,"
        f" created_at, updated_at) VALUES {rows};"
        "INSERT INTO mail_reminders (day, state, last_error_code, attention_count, imported, created_at,"
        f" updated_at) VALUES {reminders}"
    )

    for code, event_id in ids.items():
        event = assert_contract(worker.owner.get(f"/api/v1/events/{event_id}"), "/api/v1/events/{event_id}")
        assert (event["error_code"], event["imported"], event["allowed_actions"]) == (code, True, []), code
    page = assert_contract(worker.owner.get("/api/v1/reminders", params={"limit": 100}), "/api/v1/reminders")
    assert {item["error_code"] for item in page["items"]} >= set(LEGACY_REMINDER_CODES)


def test_every_read_matches_the_contract_after_traffic(worker: Worker) -> None:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    worker.wait_event(event_id, {"complete"})

    overview = assert_contract(worker.owner.get("/api/v1/overview"), "/api/v1/overview")
    assert overview["received_24h"] >= 1 and overview["build"] == "test"
    recent = assert_contract(worker.owner.get("/api/v1/events", params={"limit": 1}), "/api/v1/events")
    assert recent["items"][0]["event_id"] == event_id
    attention = worker.owner.get("/api/v1/events", params={"view": "attention"})
    assert_contract(attention, "/api/v1/events")
    setup = assert_contract(worker.owner.get("/api/v1/setup"), "/api/v1/setup")
    assert all(setup["configured"].values()) and setup["access_owner"] == OWNER
    assert_contract(worker.owner.get("/api/v1/csrf"), "/api/v1/csrf")
    assert_contract(worker.owner.get("/api/v1/reports/latest"), "/api/v1/reports/latest")


def test_an_alias_login_acts_as_the_owner(auth_worker: Worker, access: AccessIssuer) -> None:
    alias = {"cf-access-jwt-assertion": access.token(email=ALIAS)}
    owner = {"cf-access-jwt-assertion": access.token()}
    assert auth_worker.owner.get("/api/v1/overview", headers=alias).status_code == 200

    token = auth_worker.owner.get("/api/v1/csrf", headers=alias).json()["token"]
    csrf = {"origin": "http://todofy.localhost", "x-csrf-token": token, "cookie": f"todofy_csrf={token}"}
    body = {"action": "dismiss", "version": 1, "action_request_id": str(uuid.uuid4())}
    response = auth_worker.owner.post(f"/api/v1/events/{uuid.uuid4()}/reconcile", json=body, headers=owner | csrf)

    # Past Access and CSRF: the token issued to the alias belongs to ACCESS_OWNER.
    assert (response.status_code, error_code(response)) == (404, "not_found")
    intruder = {"cf-access-jwt-assertion": access.token(email="intruder@example.com")}
    assert auth_worker.owner.get("/api/v1/overview", headers=intruder).status_code == 401


@pytest.mark.reaches("access_not_configured")
def test_a_misconfigured_access_issuer_fails_closed(launch: Launch, access: AccessIssuer) -> None:
    worker = launch("wrangler.test-auth.toml", ACCESS_ISSUER="https://evil.example")
    headers = {"cf-access-jwt-assertion": access.token()}

    for path in ("/api/v1/overview", "/attention"):
        response = worker.owner.get(path, headers=headers)
        assert (response.status_code, error_code(response)) == (503, "access_not_configured"), path
    assert worker.hooks.get("/health").status_code == 200
