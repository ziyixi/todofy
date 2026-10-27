"""Global brakes: the two operator switches and the daily token budget.

Each state is global to the Durable Object, so every test here starts its own Worker.
"""

import time
from datetime import UTC, datetime, timedelta

import pytest

from tests.fakes.model_router_fake import ModelRouterFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import AUTH, HOOKS_HOST, Worker, mail_event, reason

# Long enough for several alarm cycles (each worked step re-arms after 1 s).
QUIET_S = 4


def _stamp(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _arrive(worker: Worker) -> str:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    return event_id


@pytest.mark.reaches("llm_budget_exhausted")
def test_an_exhausted_token_budget_defers_every_event_to_the_next_day(
    launch: Launch, fresh_gemini: ModelRouterFake
) -> None:
    worker = launch(GEMINI_DAILY_TOKEN_BUDGET="100")
    events = [_arrive(worker) for _ in range(2)]

    deferred = [worker.wait_event(e, lambda e: e["error_code"] == "llm_budget_exhausted") for e in events]

    tomorrow = (datetime.now(UTC) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    for event in deferred:
        assert (event["state"], _stamp(event["next_attempt_time"])) == ("pending", tomorrow)
    assert fresh_gemini.calls() == []
    overview = worker.overview()
    assert (overview["gemini"]["token_budget"], overview["active_counts"]["pending_count"]) == (100, 2)
    assert overview["active_counts"]["failed_summary_count"] == 0


@pytest.mark.reaches("maintenance", "MAINTENANCE")
def test_maintenance_refuses_mail_and_owner_writes_and_stops_the_alarm(
    launch: Launch, fresh_gemini: ModelRouterFake
) -> None:
    worker = launch(MAINTENANCE_MODE="true")
    event_id, _ = mail_event()
    now = int(time.time())
    worker.d1(
        "INSERT INTO mail_events (source_id, event_id, payload_hash, payload, state, created_at, updated_at)"
        f" VALUES ('mail-hero-personal', '{event_id}', '{'0' * 64}', '{{}}', 'pending', {now}, {now})"
    )

    # Bodiless, because the Worker answers before reading (see test_hooks_limits.py).
    status = worker.headers_only_status(HOOKS_HOST, "POST", "/hooks/mail", AUTH | {"content-length": "0"})
    assert status == 503
    assert worker.trigger_cron().status_code == 200
    time.sleep(QUIET_S)

    assert worker.event(event_id)["state"] == "pending" and fresh_gemini.calls() == []
    assert worker.overview()["switches"]["maintenance_mode"] is True
    response = worker.reconcile(event_id, "dismiss")
    assert (response.status_code, reason(response)) == (503, "MAINTENANCE")
    assert int(response.headers["retry-after"]) > 0


def test_processing_paused_accepts_mail_but_does_no_work(launch: Launch, fresh_gemini: ModelRouterFake) -> None:
    worker = launch(PROCESSING_PAUSED="true")
    event_id = _arrive(worker)

    assert worker.trigger_cron().status_code == 200
    time.sleep(QUIET_S)

    assert worker.event(event_id)["state"] == "pending"
    assert fresh_gemini.calls() == []
    assert worker.overview()["switches"]["processing_paused"] is True
