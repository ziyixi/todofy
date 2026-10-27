"""Eviction mid-call: workerd is killed while a Gemini call hangs, then restarted on the same storage.

The cron tick after each restart stands in for the persisted watchdog alarm, so no test depends on how
quickly local workerd replays an overdue alarm.
"""

import time

import pytest

from tests.fakes.model_router_fake import ModelRouterFake
from tests.fakes.server import Reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event
from todofy.core.backoff import SUMMARY_CRASH_LIMIT

# Long upstream deadlines keep every call in flight until the process dies.
SLOW = {"MODEL_TIMEOUT_MS": "60000"}


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    return launch(**SLOW)


def _restart_and_wake(worker: Worker) -> None:
    worker.crash_and_restart()
    assert worker.trigger_cron().status_code == 200


@pytest.mark.reaches("processing_interrupted_limit")
def test_three_interrupted_summaries_stop_automatic_retries(worker: Worker, fresh_gemini: ModelRouterFake) -> None:
    for _ in range(SUMMARY_CRASH_LIMIT):
        fresh_gemini.queue_generate(Reply(hang=True))
    event_id, body = mail_event()
    assert worker.post_event(body).status_code == 204

    for crash in range(1, SUMMARY_CRASH_LIMIT + 1):
        fresh_gemini.wait_for(lambda n=crash: len(fresh_gemini.calls_mentioning(event_id)) == n, timeout_s=30)
        _restart_and_wake(worker)

    event = worker.wait_event(event_id, {"failed_summary"})
    assert (event["error_code"], event["crash_count"]) == ("processing_interrupted_limit", SUMMARY_CRASH_LIMIT)
    assert event["allowed_actions"] == ["retry_summary", "dismiss"]
    time.sleep(3)
    assert len(fresh_gemini.calls_mentioning(event_id)) == SUMMARY_CRASH_LIMIT
    # Each interrupted call's reservation is settled as spent, not left reserved all day.
    usage = worker.overview()["gemini"]
    assert (usage["reserved_tokens"], usage["call_count"]) == (0, SUMMARY_CRASH_LIMIT)
    assert usage["used_tokens"] > 0
