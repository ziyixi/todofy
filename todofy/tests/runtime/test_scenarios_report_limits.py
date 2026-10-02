"""Report limits that are global per hour or per Worker: no stale fallback, lockout and the computation cap."""

import json
import time
import uuid

import pytest

from tests.fakes.gemini_fake import GeminiFake, error_reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, error_code, reason
from tests.runtime.owner_support import assert_contract

DAY = 86400
LOCKOUT_FAILURES = 20
HOURLY_REPORT_CAP = 30


def _stamp(timestamp: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def _clear_of_the_hour_boundary(margin_s: int = 10) -> None:
    """Counters are per UTC hour; do not let one test straddle two hours."""
    left = 3600 - int(time.time()) % 3600
    if left < margin_s:
        time.sleep(left + 1)


@pytest.mark.reaches("unavailable")
def test_without_a_fresh_report_a_failed_run_is_503_even_with_an_older_row(
    launch: Launch, fresh_gemini: GeminiFake
) -> None:
    worker = launch()
    now = int(time.time())
    worker.d1(
        "INSERT INTO summaries (event_id, created_at, subject, summary, model)"
        f" VALUES ('{uuid.uuid4()}', {now - 3600}, 's', '合成摘要', 'model-a')"
    )
    for _ in range(8):
        fresh_gemini.queue_generate(error_reply(500))

    missing = worker.report("/api/summary")
    assert (missing.status_code, error_code(missing)) == (503, "unavailable")

    old = now - 3 * DAY
    stored = {
        "summary": "三天前的摘要",
        "task_count": 1,
        "time_window_hours": 24,
        "status": "ok",
        "model": "model-a",
        "computed_at": _stamp(old),
        "window_start": _stamp(old - DAY),
        "window_end": _stamp(old),
    }
    payload = json.dumps(stored, ensure_ascii=False).replace("'", "''")
    worker.d1(
        "INSERT INTO daily_reports (kind, top_n, day, status, payload_json, model, task_count, window_start,"
        f" window_end, computed_at) VALUES ('summary', 0, '{_stamp(old)[:10]}', 'ok', '{payload}', 'model-a', 1,"
        f" {old - DAY}, {old}, {old})"
    )

    # The newsletter reads only the HTTP status: a three-day-old report must not look current.
    response = worker.report("/api/summary")
    assert (response.status_code, error_code(response)) == (503, "unavailable")
    assert_contract(response, "/api/summary")


@pytest.fixture(scope="module")
def limited(launch: Launch) -> Worker:
    return launch()


@pytest.mark.reaches("rate_limited")
def test_twenty_bad_passwords_lock_the_newsletter_endpoints_for_the_hour(limited: Worker) -> None:
    _clear_of_the_hour_boundary()
    for _ in range(LOCKOUT_FAILURES):
        assert limited.report("/api/summary", auth=("newsletter", "guess")).status_code == 401

    wrong = limited.report("/api/recommendation", auth=("newsletter", "guess"))
    missing = limited.hooks.get("/api/recommendation")
    for response in (wrong, missing):
        assert (response.status_code, error_code(response)) == (429, "rate_limited")
        assert 0 < int(response.headers["retry-after"]) <= 3600
    # Failures cannot lock the newsletter out: the right credential still gets its report.
    assert limited.report("/api/recommendation").status_code == 200
    assert limited.d1("SELECT count FROM auth_failures") == [{"count": LOCKOUT_FAILURES}]


@pytest.mark.reaches("RATE_LIMITED")
def test_report_computations_are_capped_per_hour(limited: Worker) -> None:
    _clear_of_the_hour_boundary(margin_s=60)
    statuses = []
    for _ in range(HOURLY_REPORT_CAP + 1):
        body = {"kind": "summary", "request_id": str(uuid.uuid4())}
        response = limited.post_owner("/api/v1/latestReports:recompute", body)
        statuses.append(response.status_code)
        if response.status_code == 429:
            assert reason(response) == "RATE_LIMITED"
            assert 0 < int(response.headers["retry-after"]) <= 3600
            break
    assert statuses[-1] == 429 and set(statuses[:-1]) == {200} and len(statuses) <= HOURLY_REPORT_CAP + 1


def test_a_rate_limited_recompute_is_not_stored_so_the_same_request_id_runs_again(limited: Worker) -> None:
    """AIP-155: only a computed report is replayed; a refusal releases the request_id (RecomputeReportRequest)."""
    _clear_of_the_hour_boundary(margin_s=60)
    for _ in range(HOURLY_REPORT_CAP + 1):
        body = {"kind": "summary", "request_id": str(uuid.uuid4())}
        if limited.post_owner("/api/v1/latestReports:recompute", body).status_code == 429:
            break
    request_id = str(uuid.uuid4())
    for _ in range(2):
        response = limited.post_owner("/api/v1/latestReports:recompute", {"kind": "summary", "request_id": request_id})
        assert (response.status_code, reason(response)) == (429, "RATE_LIMITED")
        assert 0 < int(response.headers["retry-after"]) <= 3600
        stored = limited.d1(f"SELECT count(*) AS n FROM owner_actions WHERE action_request_id = '{request_id}'")
        assert stored == [{"n": 0}]
