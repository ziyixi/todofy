"""The alarm's outbound deadline is real: a hanging upstream is abandoned and its socket closed."""

from tests.fakes.model_router_fake import ModelRouterFake, model_path
from tests.fakes.server import Reply
from tests.runtime.harness import Worker, mail_event


def test_alarm_uses_private_model_binding(worker: Worker, fresh_gemini: ModelRouterFake) -> None:
    event_id, body = mail_event()

    assert worker.post_event(body).status_code == 204

    worker.wait_event(event_id, {"complete"})
    [call] = fresh_gemini.calls_mentioning(event_id)
    assert call.requested_model == "gemini-3.5-flash-lite"


def test_timeout_really_closes_a_hanging_upstream_connection(worker: Worker, fresh_gemini: ModelRouterFake) -> None:
    fresh_gemini.queue_generate(Reply(hang=True), model="model-a")
    event_id, body = mail_event()

    assert worker.post_event(body).status_code == 204

    worker.wait_event(event_id, {"complete"})
    hung, answered = fresh_gemini.calls_mentioning(event_id)
    # The core's wrangler.test.toml sets GEMINI_TIMEOUT_MS = 1500; a timeout moves on to the next model.
    assert (hung.model, answered.model) == ("model-a", "model-a")
    # workerd arms the timeout on the isolate clock, which stands still while Pyodide builds the request,
    # so the gap the fake sees on the real clock is 1.5 s give or take a few ms (1.496-1.523 s measured).
    # 50 ms of slack still proves the call waited out the timeout rather than failing at once.
    assert 1.45 <= answered.at - hung.at < 30
    assert fresh_gemini.wait_for(lambda: fresh_gemini.disconnects, timeout_s=5) == [model_path("model-a")]
