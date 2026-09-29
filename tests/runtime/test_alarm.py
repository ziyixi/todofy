import time

from tests.fakes.server import FakeServer, Reply
from tests.runtime.harness import AUTH, Worker, event_body, spike_event

GENERATE = "/v1beta/models/spike:generateContent"


def test_alarm_calls_the_upstream_with_the_api_key(worker: Worker, fresh_gemini: FakeServer) -> None:
    fresh_gemini.default("POST", GENERATE, Reply(200, {"candidates": []}))
    event_id, body = event_body()

    assert worker.hooks.post("/hooks/mail", content=body, headers=AUTH).status_code == 204

    row = spike_event(worker.owner, event_id, until_not="pending")
    assert (row["state"], row["upstream_status"]) == ("called", 200)
    [call] = [r for r in fresh_gemini.received("POST", GENERATE) if r.json()["event_id"] == event_id]
    assert call.headers["x-goog-api-key"] == "fake-gemini-key"


def test_timeout_really_closes_a_hanging_upstream_connection(worker: Worker, fresh_gemini: FakeServer) -> None:
    fresh_gemini.queue("POST", GENERATE, Reply(hang=True))
    event_id, body = event_body()
    started = time.monotonic()

    assert worker.hooks.post("/hooks/mail", content=body, headers=AUTH).status_code == 204

    row = spike_event(worker.owner, event_id, until_not="pending")
    elapsed = time.monotonic() - started
    assert (row["state"], row["upstream_status"]) == ("timeout", None)
    # wrangler.test.toml sets GEMINI_TIMEOUT_MS = 1500.
    assert 1.5 <= elapsed < 10
    assert fresh_gemini.wait_for(lambda: fresh_gemini.disconnects, timeout_s=5) == [GENERATE]
