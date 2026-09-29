"""Owner API reads and write validation against real D1, with every response checked
against the OpenAPI contract. Rows are seeded straight into D1 with processing
paused, so the coordinator never touches them.
"""

import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote

import pytest

from tests.runtime.harness import Worker, start_worker
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
HOUR = 3600
DAY = 24 * HOUR


def eid(n: int) -> str:
    return f"f8c1e9a0-1a98-4fb8-8ca1-4c0a3e71{n:04d}"


PENDING, FAILED, UNKNOWN, AGED, DONE = eid(1), eid(2), eid(3), eid(4), eid(5)
TIED = [eid(10 + n) for n in range(5)]
OTHER_SOURCE = eid(99)
EVENTS = [
    event_row(PENDING, "pending", NOW - 60),
    event_row(FAILED, "failed_summary", NOW - 120, last_error_code="summary_failed", attempt_count=12),
    event_row(UNKNOWN, "todo_unknown", NOW - 180, last_error_code="todo_result_unknown", next_attempt_at=NOW + 100),
    event_row(AGED, "summarized", NOW - 7 * HOUR, next_attempt_at=NOW + HOUR, last_error_code="todoist_rate_limited"),
    event_row(DONE, "complete", NOW - 8 * HOUR, task_id="6X7rM8997g3RQmvh"),
    *[event_row(event_id, "complete", NOW - 2 * DAY, task_id=str(n), imported=1) for n, event_id in enumerate(TIED)],
    event_row(OTHER_SOURCE, "failed_summary", NOW - 60, source_id="another-source"),
]
RECENT_ORDER = [PENDING, FAILED, UNKNOWN, AGED, DONE, *sorted(TIED, reverse=True)]
LEGACY_KEY = "legacy:abc-123"
LEGACY_TEXT = [
    {"event_id": DONE, "created_at": NOW - DAY, "text": "旧邮件全文\nline 2", "expires_at": None},
    {"event_id": LEGACY_KEY, "created_at": NOW - DAY, "text": "imported only", "expires_at": NOW + DAY},
    {"event_id": TIED[0], "created_at": NOW - DAY, "text": "expired", "expires_at": NOW - 1},
]


def _day(offset: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(NOW - offset * DAY))


REMINDERS = [
    {
        "day": _day(offset),
        "state": state,
        "task_id": task_id,
        "attention_count": 3,
        "attempts": 1,
        "last_error_code": code,
        "created_at": NOW - offset * DAY,
        "updated_at": NOW - offset * DAY,
    }
    for offset, state, task_id, code in [
        (1, "created", "9001", ""),
        (2, "unknown", "", "reminder_result_unknown"),
        (3, "failed", "", "reminder_create_failed"),
    ]
]


@pytest.fixture(scope="module")
def api_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    for worker in start_worker(
        "wrangler.test.toml",
        tmp_path_factory.mktemp("owner-api-worker"),
        {"CSRF_SIGNING_KEY": CSRF_KEY, "PROCESSING_PAUSED": "true", "REMINDER_ENABLED": "true"},
    ):
        seed(worker, "mail_events", EVENTS)
        seed(worker, "legacy_mail_text", LEGACY_TEXT)
        seed(worker, "mail_reminders", REMINDERS)
        yield worker


def _pages(worker: Worker, **params: Any) -> list[dict[str, Any]]:
    """Walk a listing with its cursors; every page must satisfy EventPage."""
    items, cursor = [], None
    while True:
        response = worker.owner.get("/api/v1/events", params=params | ({"cursor": cursor} if cursor else {}))
        assert response.status_code == 200, response.text
        page = assert_contract(response, "/api/v1/events")
        assert len(page["items"]) <= params.get("limit", 50)
        items += page["items"]
        cursor = page["next_cursor"]
        if cursor is None:
            return items


def test_recent_pages_walk_every_event_newest_first(api_worker: Worker) -> None:
    items = _pages(api_worker, limit=2)
    assert [item["event_id"] for item in items] == RECENT_ORDER
    assert _pages(api_worker) == items
    by_id = {item["event_id"]: item for item in items}
    assert by_id[PENDING]["next_attempt_at"] == by_id[PENDING]["received_at"]  # due since arrival
    assert by_id[UNKNOWN]["next_attempt_at"] is not None  # its scheduled footer lookup
    assert by_id[FAILED]["next_attempt_at"] is None and by_id[DONE]["next_attempt_at"] is None
    assert by_id[DONE]["task_id"] == "6X7rM8997g3RQmvh" and by_id[PENDING]["task_id"] is None
    assert by_id[PENDING]["error_code"] is None and by_id[FAILED]["error_code"] == "summary_failed"
    assert by_id[TIED[0]]["imported"] is True and by_id[PENDING]["imported"] is False
    assert {item["event_id"] for item in items if item["attention"]} == {FAILED, UNKNOWN, AGED}


def test_state_filter_and_attention_view(api_worker: Worker) -> None:
    complete = _pages(api_worker, state="complete", limit=4)
    assert [item["event_id"] for item in complete] == [DONE, *sorted(TIED, reverse=True)]
    attention = _pages(api_worker, view="attention", limit=1)
    assert [item["event_id"] for item in attention] == [AGED, UNKNOWN, FAILED]  # oldest first


def test_list_rows_never_carry_mail_content(api_worker: Worker) -> None:
    item = api_worker.owner.get("/api/v1/events").json()["items"][0]
    assert set(item) == {
        "event_id",
        "state",
        "error_code",
        "attempt_count",
        "task_id",
        "received_at",
        "updated_at",
        "next_attempt_at",
        "attention",
        "imported",
    }


@pytest.mark.parametrize(
    "query",
    [
        "view=everything",
        "view=attention&state=pending",
        "state=done",
        "limit=0",
        "limit=101",
        "limit=ten",
        "limit=%EF%BC%95",  # a full-width digit
        "cursor=%21%21%21",
        "cursor=" + "A" * 257,
        "cursor=bm90LWEtY3Vyc29y",  # base64url of "not-a-cursor"
        "view=recent&view=attention",
    ],
)
def test_invalid_listing_queries_get_400(api_worker: Worker, query: str) -> None:
    response = api_worker.owner.get(f"/api/v1/events?{query}")
    assert (response.status_code, error_code(response)) == (400, "invalid_request")
    assert_contract(response, "/api/v1/events")
    assert_private(response)


def test_legacy_text_is_served_until_it_expires(api_worker: Worker) -> None:
    response = api_worker.owner.get(f"/api/v1/legacy_text/{DONE}")
    body = assert_contract(response, "/api/v1/legacy_text/{event_id}")
    assert (body["text"], body["expires_at"]) == ("旧邮件全文\nline 2", None)
    assert_private(response)

    imported = api_worker.owner.get(f"/api/v1/legacy_text/{quote(LEGACY_KEY, safe='')}")
    assert assert_contract(imported, "/api/v1/legacy_text/{event_id}")["event_id"] == LEGACY_KEY

    for key in (TIED[0], PENDING, "legacy:", "not-an-id", "legacy:a%2Fb"):
        missing = api_worker.owner.get(f"/api/v1/legacy_text/{key}")
        assert (missing.status_code, error_code(missing)) == (404, "not_found"), key

    # The event detail offers the text exactly when the endpoint above would serve it.
    offered = {
        event_id: api_worker.owner.get(f"/api/v1/events/{event_id}").json()["has_legacy_text"]
        for event_id in (DONE, TIED[0], PENDING)
    }
    assert offered == {DONE: True, TIED[0]: False, PENDING: False}


def test_setup_reports_presence_never_values(api_worker: Worker) -> None:
    response = api_worker.owner.get("/api/v1/setup")
    body = assert_contract(response, "/api/v1/setup")
    assert body["public_host"] == "todofy.localhost"
    assert body["hooks_hosts"] == ["todofy-hooks.localhost"]
    assert body["mail_source_id"] == "mail-hero-personal"
    assert body["configured"]["mail_webhook_token"] is False
    assert CSRF_KEY not in response.text


def test_overview_counts_active_rows_of_this_source(api_worker: Worker) -> None:
    response = api_worker.owner.get("/api/v1/overview")
    body = assert_contract(response, "/api/v1/overview")
    assert body["counts"] == {
        "pending": 1,
        "summarizing": 0,
        "summarized": 1,
        "todo_sending": 0,
        "todo_unknown": 1,
        "todo_created": 0,
        "failed_summary": 1,
    }
    assert body["attention_count"] == 3
    assert body["received_24h"] == 5
    assert body["flags"] == {
        "maintenance_mode": False,
        "processing_paused": True,
        "force_pause_todoist": False,
        "reminder_enabled": True,
    }
    # The pending row is due since arrival; the summarized one is not due yet.
    assert body["oldest_due_at"] == _pages(api_worker, state="pending")[0]["received_at"]
    assert body["latest_reminder"]["day"] == REMINDERS[0]["day"]
    assert_private(response)


def test_reminders_page_newest_day_first(api_worker: Worker) -> None:
    days, cursor = [], None
    while True:
        response = api_worker.owner.get(
            "/api/v1/reminders", params={"limit": 2} | ({"cursor": cursor} if cursor else {})
        )
        page = assert_contract(response, "/api/v1/reminders")
        days += [item["day"] for item in page["items"]]
        if (cursor := page["next_cursor"]) is None:
            break
    assert days == [reminder["day"] for reminder in REMINDERS]
    bad = api_worker.owner.get("/api/v1/reminders", params={"cursor": "bm90LWEtZGF5"})
    assert (bad.status_code, error_code(bad)) == (400, "invalid_request")


def test_latest_reports_without_any_report(api_worker: Worker) -> None:
    response = api_worker.owner.get("/api/v1/reports/latest")
    assert assert_contract(response, "/api/v1/reports/latest") == {"summary": None, "recommendations": []}


def test_unknown_or_malformed_event_ids_are_404(api_worker: Worker) -> None:
    for path in ("/api/v1/events/not-a-uuid", "/api/v1/events/%2E%2E", f"/api/v1/events/{eid(4242)}"):
        response = api_worker.owner.get(path)
        assert (response.status_code, error_code(response)) == (404, "not_found"), path
        assert_contract(response, "/api/v1/events/{event_id}")
        assert_private(response)


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'{"action": "dismiss", "version": 1}',
        b'{"action": "dismiss", "version": 0, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"action": "dismiss", "version": true, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"action": "dismiss", "version": 1.0, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"action": "dismiss", "version": 1, "action_request_id": "not-a-uuid"}',
        b'{"action": "resend", "version": 1, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"action": "task_created", "version": 1, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"action": "task_created", "version": 1, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11",'
        b' "task_id": "has space"}',
        b'{"action": "dismiss", "version": 1, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11",'
        b' "task_id": "1"}',
        b'{"action": "dismiss", "version": 1, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11",'
        b' "confirmed": true}',
    ],
)
def test_invalid_reconcile_bodies_get_400(api_worker: Worker, body: bytes) -> None:
    headers = issue_csrf(api_worker.owner) | {"content-type": "application/json"}
    response = api_worker.owner.post(f"/api/v1/events/{UNKNOWN}/reconcile", headers=headers, content=body)
    assert (response.status_code, error_code(response)) == (400, "invalid_request")
    assert_contract(response, "/api/v1/events/{event_id}/reconcile", "post")


@pytest.mark.parametrize(
    "body",
    [
        b'{"kind": "summary", "top": 3, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"kind": "recommendation", "top": 11, "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"kind": "recommendation", "top": "3", "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"kind": "digest", "action_request_id": "3b0d7a52-8f0e-4a8e-9a55-2f0f6c1d9e11"}',
        b'{"kind": "summary"}',
    ],
)
def test_invalid_recompute_bodies_get_400(api_worker: Worker, body: bytes) -> None:
    headers = issue_csrf(api_worker.owner) | {"content-type": "application/json"}
    response = api_worker.owner.post("/api/v1/reports/recompute", headers=headers, content=body)
    assert (response.status_code, error_code(response)) == (400, "invalid_request")
    assert_contract(response, "/api/v1/reports/recompute", "post")


# Keep last: the Worker answers before reading the body, which can upset the
# local proxy's next POST on this dev server (docs/dev-notes.md §3).
def test_oversized_owner_bodies_are_rejected(api_worker: Worker) -> None:
    headers = issue_csrf(api_worker.owner) | {"content-type": "application/json"}
    body = b'{"kind": "summary", "action_request_id": "' + b"x" * (17 << 10) + b'"}'
    response = api_worker.owner.post("/api/v1/reports/recompute", headers=headers, content=body)
    assert (response.status_code, error_code(response)) == (400, "invalid_request")
