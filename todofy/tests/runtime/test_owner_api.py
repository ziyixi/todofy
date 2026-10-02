"""Owner API (todofy.ui.v1) reads and write validation against real D1, with every answer read strictly by the
generated Python code. Rows are seeded straight into D1 with processing paused, so the coordinator never touches
them.
"""

import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote

import pytest
from ziyixi_proto.todofy.ui.v1 import mail_event_pb, reports_pb, status_pb
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
    for worker in start_gateway(
        tmp_path_factory.mktemp("owner-api-worker"),
        {"CSRF_SIGNING_KEY": CSRF_KEY, "PROCESSING_PAUSED": "true", "REMINDER_ENABLED": "true"},
    ):
        seed(worker, "mail_events", EVENTS)
        seed(worker, "legacy_mail_text", LEGACY_TEXT)
        seed(worker, "mail_reminders", REMINDERS)
        yield worker


def _id(item: dict[str, Any]) -> str:
    return item["name"].removeprefix("mailEvents/")


def _pages(worker: Worker, **params: Any) -> list[dict[str, Any]]:
    """Walk a listing with its page tokens; every page must be a ListMailEventsResponse."""
    items, token = [], None
    while True:
        response = worker.owner.get("/api/v1/mailEvents", params=params | ({"page_token": token} if token else {}))
        page = assert_message(response, pb.ListMailEventsResponse)
        assert len(page.get("mail_events", [])) <= params.get("page_size", 50)
        items += page.get("mail_events", [])
        token = page.get("next_page_token")
        if not token:
            return items


def test_recent_pages_walk_every_event_newest_first(api_worker: Worker) -> None:
    items = _pages(api_worker, page_size=2)
    assert [_id(item) for item in items] == RECENT_ORDER
    assert _pages(api_worker) == items
    by_id = {_id(item): item for item in items}
    assert by_id[PENDING]["next_attempt_time"] == by_id[PENDING]["receive_time"]  # due since arrival
    assert "next_attempt_time" in by_id[UNKNOWN]  # its scheduled footer lookup
    assert "next_attempt_time" not in by_id[FAILED] and "next_attempt_time" not in by_id[DONE]
    assert by_id[DONE]["task_id"] == "6X7rM8997g3RQmvh" and "task_id" not in by_id[PENDING]
    assert "error_code" not in by_id[PENDING] and by_id[FAILED]["error_code"] == "summary_failed"
    assert by_id[TIED[0]]["imported"] is True and "imported" not in by_id[PENDING]
    assert {_id(item) for item in items if item.get("attention")} == {FAILED, UNKNOWN, AGED}


def test_state_filter_and_attention_list(api_worker: Worker) -> None:
    complete = _pages(api_worker, filter="state = COMPLETE", page_size=4)
    assert [_id(item) for item in complete] == [DONE, *sorted(TIED, reverse=True)]
    assert _pages(api_worker, filter="state=COMPLETE") == complete
    attention = _pages(api_worker, filter="attention = true", page_size=1)
    assert [_id(item) for item in attention] == [AGED, UNKNOWN, FAILED]  # oldest first


def test_list_rows_never_carry_mail_content(api_worker: Worker) -> None:
    rows = api_worker.owner.get("/api/v1/mailEvents").json()["mail_events"]
    allowed = {
        "name",
        "state",
        "error_code",
        "attempt_count",
        "task_id",
        "receive_time",
        "update_time",
        "next_attempt_time",
        "attention",
        "imported",
    }
    assert all(set(row) <= allowed for row in rows)


def test_list_and_get_views_follow_aip_157(api_worker: Worker) -> None:
    [listed] = [item for item in _pages(api_worker) if _id(item) == UNKNOWN]
    assert _pages(api_worker, view="basic") == _pages(api_worker)
    basic = api_worker.owner.get(f"/api/v1/mailEvents/{UNKNOWN}", params={"view": "basic"})
    assert assert_message(basic, mail_event_pb.MailEvent) == listed
    full = assert_message(api_worker.owner.get(f"/api/v1/mailEvents/{UNKNOWN}"), mail_event_pb.MailEvent)
    assert full == assert_message(
        api_worker.owner.get(f"/api/v1/mailEvents/{UNKNOWN}", params={"view": "full"}), mail_event_pb.MailEvent
    )
    assert {"etag", "version", "allowed_actions"} <= set(full) and full.items() >= listed.items()


def test_page_size_follows_aip_158(api_worker: Worker) -> None:
    assert len(_pages(api_worker, page_size=1000)) == len(RECENT_ORDER)  # read as 100
    page = assert_message(
        api_worker.owner.get("/api/v1/mailEvents", params={"page_size": 1}), pb.ListMailEventsResponse
    )
    assert len(page["mail_events"]) == 1 and page["next_page_token"]


@pytest.mark.parametrize(
    "query",
    [
        "view=attention",
        "view=full",  # a page in full would read every event's detail (MailEventView)
        "attention=true",
        "state=pending",
        "filter=state%20%3D%20DONE",
        "filter=state%20%3D%20pending",
        "filter=attention%20%3D%20true%20AND%20state%20%3D%20PENDING",
        "filter=attention%20%3D%20false",
        "page_size=-1",
        "page_size=ten",
        "page_size=%EF%BC%95",  # a full-width digit
        "page_token=%21%21%21",
        "page_token=" + "A" * 1025,
        "page_token=bm90LWEtdG9rZW4",  # base64url of "not-a-token"
        "filter=a&filter=b",
        "limit=5",
    ],
)
def test_invalid_listing_queries_get_bad_request(api_worker: Worker, query: str) -> None:
    response = api_worker.owner.get(f"/api/v1/mailEvents?{query}")
    assert_status(response, 400, "BAD_REQUEST")
    assert_private(response)


def test_a_page_token_is_bound_to_its_list(api_worker: Worker) -> None:
    first = assert_message(
        api_worker.owner.get("/api/v1/mailEvents", params={"filter": "state = COMPLETE", "page_size": 1}),
        pb.ListMailEventsResponse,
    )
    token = first["next_page_token"]
    other = api_worker.owner.get("/api/v1/mailEvents", params={"page_token": token, "page_size": 1})
    assert_status(other, 400, "BAD_REQUEST")
    same = api_worker.owner.get(
        "/api/v1/mailEvents", params={"filter": "state = COMPLETE", "page_token": token, "page_size": 9}
    )
    assert len(assert_message(same, pb.ListMailEventsResponse)["mail_events"]) == len(TIED)


def test_legacy_text_is_served_until_it_expires(api_worker: Worker) -> None:
    response = api_worker.owner.get(f"/api/v1/legacyTexts/{DONE}")
    body = assert_message(response, mail_event_pb.LegacyText)
    assert (body["text"], "expire_time" in body, body["name"]) == ("旧邮件全文\nline 2", False, f"legacyTexts/{DONE}")
    assert_private(response)

    imported = api_worker.owner.get(f"/api/v1/legacyTexts/{quote(LEGACY_KEY, safe='')}")
    assert assert_message(imported, mail_event_pb.LegacyText)["name"] == f"legacyTexts/{LEGACY_KEY}"

    for key in (TIED[0], PENDING, "legacy%3A", "not-an-id", "legacy%3Aa%252Fb"):
        missing = api_worker.owner.get(f"/api/v1/legacyTexts/{key}")
        assert_status(missing, 404, "NOT_FOUND")

    # The event offers the text exactly when the method above would serve it.
    offered = {
        event_id: api_worker.owner.get(f"/api/v1/mailEvents/{event_id}").json().get("legacy_text")
        for event_id in (DONE, TIED[0], PENDING)
    }
    assert offered == {DONE: f"legacyTexts/{DONE}", TIED[0]: None, PENDING: None}


def test_a_legacy_text_near_the_d1_row_limit_is_served(api_worker: Worker) -> None:
    # 632,000 three-byte characters (~1.9 MB), built in SQL so the command stays short.
    key = "legacy:large-text"
    api_worker.d1(
        "INSERT INTO legacy_mail_text (event_id, created_at, text, expires_at)"
        f" VALUES ('{key}', {NOW - DAY}, replace(hex(zeroblob(316000)), '0', '邮'), NULL)"
    )
    response = api_worker.owner.get(f"/api/v1/legacyTexts/{quote(key, safe='')}")
    body = assert_message(response, mail_event_pb.LegacyText)
    assert len(body["text"]) == 632_000 and set(body["text"]) == {"邮"}
    assert_private(response)


def test_integration_reports_presence_never_values(api_worker: Worker) -> None:
    response = api_worker.owner.get("/api/v1/integration")
    body = assert_message(response, status_pb.Integration)
    assert body["public_host"] == "todofy.localhost"
    assert body["hooks_hosts"] == ["todofy-hooks.localhost"]
    assert body["mail_source_id"] == "mail-hero-personal"
    assert "mail_webhook_token" not in body["configured"]
    assert CSRF_KEY not in response.text


def test_service_status_counts_active_rows_of_this_source(api_worker: Worker) -> None:
    response = api_worker.owner.get("/api/v1/serviceStatus")
    body = assert_message(response, status_pb.ServiceStatus)
    assert body["active_counts"] == {
        "pending_count": 1,
        "summarized_count": 1,
        "todo_unknown_count": 1,
        "failed_summary_count": 1,
    }
    assert body["attention_count"] == 3
    assert body["received_last_day_count"] == 5
    assert body["switches"] == {"processing_paused": True, "reminder_enabled": True}
    # The pending row is due since arrival; the summarized one is not due yet.
    assert body["oldest_due_time"] == _pages(api_worker, filter="state = PENDING")[0]["receive_time"]
    assert body["latest_reminder"]["name"] == f"dailyReminders/{REMINDERS[0]['day']}"
    assert_private(response)


def test_reminders_page_newest_day_first(api_worker: Worker) -> None:
    days, token = [], None
    while True:
        response = api_worker.owner.get(
            "/api/v1/dailyReminders", params={"page_size": 2} | ({"page_token": token} if token else {})
        )
        page = assert_message(response, pb.ListDailyRemindersResponse)
        days += [item["name"].removeprefix("dailyReminders/") for item in page["daily_reminders"]]
        if not (token := page.get("next_page_token")):
            break
    assert days == [reminder["day"] for reminder in REMINDERS]
    bad = api_worker.owner.get("/api/v1/dailyReminders", params={"page_token": "bm90LWEtZGF5"})
    assert_status(bad, 400, "BAD_REQUEST")


def test_latest_reports_without_any_report(api_worker: Worker) -> None:
    response = api_worker.owner.get("/api/v1/latestReports")
    assert assert_message(response, reports_pb.LatestReports) == {"name": "latestReports"}


def test_metric_and_gtd_days_page_newest_first(api_worker: Worker) -> None:
    yesterday = time.strftime("%Y-%m-%d", time.gmtime(NOW - DAY))
    first = assert_message(
        api_worker.owner.get("/api/v1/metricDays", params={"page_size": 2}), pb.ListMetricDaysResponse
    )
    names = [day["name"] for day in first["metric_days"]]
    assert names == [f"metricDays/{yesterday}", f"metricDays/{_day(2)}"]
    assert all(day.get("recorded") is None for day in first["metric_days"])  # nothing counted yet
    second = api_worker.owner.get("/api/v1/metricDays", params={"page_size": 2, "page_token": first["next_page_token"]})
    assert [day["name"] for day in assert_message(second, pb.ListMetricDaysResponse)["metric_days"]] == [
        f"metricDays/{_day(3)}",
        f"metricDays/{_day(4)}",
    ]
    gtd = assert_message(api_worker.owner.get("/api/v1/gtdDays", params={"page_size": 3}), pb.ListGtdDaysResponse)
    assert [day["name"] for day in gtd["gtd_days"]] == [f"gtdDays/{_day(n)}" for n in range(3)]
    everything = assert_message(
        api_worker.owner.get("/api/v1/gtdDays", params={"page_size": 1000}), pb.ListGtdDaysResponse
    )
    assert len(everything["gtd_days"]) == 120 and "next_page_token" not in everything
    reviews = assert_message(api_worker.owner.get("/api/v1/gtdReviews"), pb.ListGtdReviewsResponse)
    assert reviews == {}


def test_unknown_or_malformed_event_names_are_not_found(api_worker: Worker) -> None:
    for path in ("/api/v1/mailEvents/not-a-uuid", f"/api/v1/mailEvents/{eid(4242)}"):
        response = api_worker.owner.get(path)
        assert_status(response, 404, "NOT_FOUND")
        assert_private(response)
    dotted = api_worker.owner.get("/api/v1/mailEvents/%2E%2E")
    assert dotted.status_code in (400, 404), dotted.text


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b'{"action": "dismiss"}',
        b'{"action": "dismiss", "etag": 1}',
        b'{"action": "dismiss", "etag": "1", "request_id": "not-a-uuid"}',
        b'{"action": "dismiss", "etag": "1", "request_id": "3b0d7a52-8f0e-1a8e-9a55-2f0f6c1d9e11"}',
        b'{"action": "resend", "etag": "1"}',
        b'{"action": "task_created", "etag": "1"}',
        b'{"action": "task_created", "etag": "1", "task_id": "has space"}',
        b'{"action": "dismiss", "etag": "1", "task_id": "1"}',
        b'{"action": "dismiss", "etag": "1", "confirmed": true}',
        b'{"action": "dismiss", "etag": "1", "version": 1}',
    ],
)
def test_invalid_reconcile_bodies_get_bad_request(api_worker: Worker, body: bytes) -> None:
    headers = issue_csrf(api_worker.owner) | {"content-type": "application/json"}
    response = api_worker.owner.post(f"/api/v1/mailEvents/{UNKNOWN}:reconcile", headers=headers, content=body)
    assert_status(response, 400, "BAD_REQUEST")


@pytest.mark.parametrize(
    "body",
    [
        b'{"name": "latestReports", "kind": "summary", "top_n": 3}',
        b'{"name": "latestReports", "kind": "recommendation", "top_n": 11}',
        b'{"name": "latestReports", "kind": "recommendation", "top_n": "3"}',
        b'{"name": "latestReports", "kind": "digest"}',
        b'{"name": "latestReports"}',
        b'{"name": "elsewhere", "kind": "summary"}',
    ],
)
def test_invalid_recompute_bodies_get_bad_request(api_worker: Worker, body: bytes) -> None:
    headers = issue_csrf(api_worker.owner) | {"content-type": "application/json"}
    response = api_worker.owner.post("/api/v1/latestReports:recompute", headers=headers, content=body)
    assert_status(response, 400, "BAD_REQUEST")


# Keep last: the Worker answers before reading the body, which can upset the
# local proxy's next POST on this dev server (docs/dev-notes.md §3).
def test_oversized_owner_bodies_are_rejected(api_worker: Worker) -> None:
    headers = issue_csrf(api_worker.owner) | {"content-type": "application/json"}
    body = b'{"name": "latestReports", "kind": "summary", "request_id": "' + b"x" * (17 << 10) + b'"}'
    response = api_worker.owner.post("/api/v1/latestReports:recompute", headers=headers, content=body)
    assert_status(response, 400, "BAD_REQUEST")
