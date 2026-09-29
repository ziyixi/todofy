"""Global brakes: the three operator switches, the Todoist auth block and the daily token budget.

Each state is global to the Durable Object, so every test here starts its own Worker.
"""

import time
from datetime import UTC, datetime, timedelta

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.server import Reply
from tests.fakes.todoist_fake import TASKS_PATH, TodoistFake
from tests.runtime.conftest import Launch
from tests.runtime.harness import AUTH, HOOKS_HOST, Worker, error_code, mail_event

# Long enough for several alarm cycles (each worked step re-arms after 1 s).
QUIET_S = 4


def _stamp(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _arrive(worker: Worker) -> str:
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204
    return event_id


@pytest.mark.reaches("todoist_auth_blocked")
@pytest.mark.parametrize("status", [401, 403])
def test_a_todoist_auth_failure_pauses_the_whole_task_stage(
    launch: Launch, fresh_todoist: TodoistFake, status: int
) -> None:
    worker = launch()
    fresh_todoist.queue("POST", TASKS_PATH, Reply(status, {"error": "forbidden"}))
    first = _arrive(worker)

    blocked = worker.wait_event(first, lambda e: e["error_code"] == "todoist_auth_blocked")
    second = _arrive(worker)
    worker.wait_event(second, {"summarized"})
    time.sleep(QUIET_S)

    assert blocked["state"] == "summarized"
    until = _stamp(worker.overview()["todoist"]["blocked_until"])
    assert abs(until - datetime.now(UTC) - timedelta(hours=6)) < timedelta(minutes=1)
    assert worker.event(second)["state"] == "summarized"
    assert len(fresh_todoist.creates()) == 1


@pytest.mark.reaches("llm_budget_exhausted")
def test_an_exhausted_token_budget_defers_every_event_to_the_next_day(launch: Launch, fresh_gemini: GeminiFake) -> None:
    worker = launch(GEMINI_DAILY_TOKEN_BUDGET="100")
    events = [_arrive(worker) for _ in range(2)]

    deferred = [worker.wait_event(e, lambda e: e["error_code"] == "llm_budget_exhausted") for e in events]

    tomorrow = (datetime.now(UTC) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    for event in deferred:
        assert (event["state"], _stamp(event["next_attempt_at"])) == ("pending", tomorrow)
    assert fresh_gemini.calls() == []
    overview = worker.overview()
    assert (overview["gemini"]["token_budget"], overview["counts"]["pending"]) == (100, 2)
    assert overview["counts"]["failed_summary"] == 0


@pytest.mark.reaches("maintenance")
def test_maintenance_refuses_mail_and_owner_writes_and_stops_the_alarm(
    launch: Launch, fresh_gemini: GeminiFake
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
    assert worker.overview()["flags"]["maintenance_mode"] is True
    response = worker.reconcile(event_id, "dismiss")
    assert (response.status_code, error_code(response)) == (503, "maintenance")
    assert int(response.headers["retry-after"]) > 0


def test_processing_paused_accepts_mail_but_does_no_work(launch: Launch, fresh_gemini: GeminiFake) -> None:
    worker = launch(PROCESSING_PAUSED="true")
    event_id = _arrive(worker)

    assert worker.trigger_cron().status_code == 200
    time.sleep(QUIET_S)

    assert worker.event(event_id)["state"] == "pending"
    assert fresh_gemini.calls() == []
    assert worker.overview()["flags"]["processing_paused"] is True


def test_force_pause_todoist_summarises_but_holds_tasks(
    launch: Launch, fresh_gemini: GeminiFake, fresh_todoist: TodoistFake
) -> None:
    worker = launch(FORCE_PAUSE_TODOIST="true")
    event_id = _arrive(worker)

    worker.wait_event(event_id, {"summarized"})
    time.sleep(QUIET_S)

    assert worker.event(event_id)["state"] == "summarized"
    assert len(fresh_gemini.calls_mentioning(event_id)) == 1 and fresh_todoist.creates() == []
    assert worker.overview()["flags"]["force_pause_todoist"] is True
