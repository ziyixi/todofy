"""The 10-minute cron is the safety net for a lost alarm (v2 plan §5.4)."""

import time

import pytest

from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.server import Reply
from tests.runtime.conftest import Launch
from tests.runtime.harness import Worker, mail_event, transitions


@pytest.fixture(scope="module")
def slow_worker(launch: Launch) -> Worker:
    # A long model timeout keeps the call in flight until the process is killed.
    return launch(GEMINI_TIMEOUT_MS="60000")


def test_cron_heals_an_alarm_lost_with_the_object_storage(slow_worker: Worker, fresh_gemini: GeminiFake) -> None:
    fresh_gemini.queue_generate(Reply(hang=True))
    event_id, body = mail_event()
    assert slow_worker.post_event(body).status_code == 204
    fresh_gemini.wait_for(lambda: fresh_gemini.calls_mentioning(event_id))

    slow_worker.crash_and_restart(lose_object_storage=True)
    # No alarm survived and nothing else wakes the object (WATCHDOG_MS is 2 s).
    time.sleep(3)
    assert slow_worker.event(event_id)["state"] == "summarizing"

    assert slow_worker.trigger_cron().status_code == 200
    event = slow_worker.wait_event(event_id, {"complete"})
    assert event["crash_count"] == 1
    assert any(step[:2] == ("summarizing", "pending") for step in transitions(event))
    assert len(fresh_gemini.calls_mentioning(event_id)) == 2
