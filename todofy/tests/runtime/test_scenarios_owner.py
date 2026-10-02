"""The owner surface after real traffic: imported legacy rows, reads the IDL accepts and Access identity."""

import time
import uuid

import pytest
from ziyixi_proto.todofy.ui.v1 import mail_event_pb, reports_pb, status_pb
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

from tests.runtime.conftest import Launch
from tests.runtime.harness import GATEWAY_AUTH_CONFIG, OWNER, AccessIssuer, Worker, error_code, mail_event
from tests.runtime.owner_support import assert_message, assert_status
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
        event = assert_message(worker.owner.get(f"/api/v1/mailEvents/{event_id}"), mail_event_pb.MailEvent)
        assert (event["error_code"], event["imported"], "allowed_actions" in event) == (code, True, False), code
    response = worker.owner.get("/api/v1/dailyReminders", params={"page_size": 100})
    page = assert_message(response, pb.ListDailyRemindersResponse)
    assert {item.get("error_code") for item in page["daily_reminders"]} >= set(LEGACY_REMINDER_CODES)


def test_every_read_matches_the_idl_after_traffic(worker: Worker) -> None:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    worker.wait_event(event_id, {"complete"})

    status = assert_message(worker.owner.get("/api/v1/serviceStatus"), status_pb.ServiceStatus)
    assert status["received_last_day_count"] >= 1 and status["build"] == "test"
    recent = assert_message(worker.owner.get("/api/v1/mailEvents", params={"page_size": 1}), pb.ListMailEventsResponse)
    assert recent["mail_events"][0]["name"] == f"mailEvents/{event_id}"
    assert_message(worker.owner.get("/api/v1/mailEvents", params={"attention": "true"}), pb.ListMailEventsResponse)
    integration = assert_message(worker.owner.get("/api/v1/integration"), status_pb.Integration)
    assert len(integration["configured"]) == 5 and integration["access_owner"] == OWNER
    assert worker.owner.get("/api/csrf").status_code == 200
    assert_message(worker.owner.get("/api/v1/latestReports"), reports_pb.LatestReports)
    assert_message(worker.owner.get("/api/v1/metricDays"), pb.ListMetricDaysResponse)
    assert_message(worker.owner.get("/api/v1/gtdDays"), pb.ListGtdDaysResponse)
    assert_message(worker.owner.get("/api/v1/gtdReviews"), pb.ListGtdReviewsResponse)


def test_an_alias_login_acts_as_the_owner(auth_worker: Worker, access: AccessIssuer) -> None:
    alias = {"cf-access-jwt-assertion": access.token(email=ALIAS)}
    owner = {"cf-access-jwt-assertion": access.token()}
    assert auth_worker.owner.get("/api/v1/serviceStatus", headers=alias).status_code == 200

    token = auth_worker.owner.get("/api/csrf", headers=alias).json()["token"]
    csrf = {"origin": "http://todofy.localhost", "x-csrf-token": token, "cookie": f"todofy_csrf={token}"}
    body = {"action": "dismiss", "etag": "1", "request_id": str(uuid.uuid4())}
    response = auth_worker.owner.post(f"/api/v1/mailEvents/{uuid.uuid4()}:reconcile", json=body, headers=owner | csrf)

    # Past Access and CSRF: the token issued to the alias belongs to ACCESS_OWNER.
    assert_status(response, 404, "NOT_FOUND")
    intruder = {"cf-access-jwt-assertion": access.token(email="intruder@example.com")}
    assert auth_worker.owner.get("/api/v1/serviceStatus", headers=intruder).status_code == 401


@pytest.mark.reaches("access_not_configured", "ACCESS_NOT_CONFIGURED")
def test_a_misconfigured_access_issuer_fails_closed(launch: Launch, access: AccessIssuer) -> None:
    worker = launch(GATEWAY_AUTH_CONFIG, ACCESS_ISSUER="https://evil.example")
    headers = {"cf-access-jwt-assertion": access.token()}

    for path in ("/api/v1/serviceStatus", "/attention"):
        response = worker.owner.get(path, headers=headers)
        assert_status(response, 503, "ACCESS_NOT_CONFIGURED")
    # An old UI tab still reads its envelope (the owner API before todofy.ui.v1, for one release).
    old = worker.owner.get("/api/v1/overview", headers=headers)
    assert (old.status_code, error_code(old)) == (503, "access_not_configured")
    assert worker.hooks.get("/health").status_code == 200
