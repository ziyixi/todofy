"""gemini.generate in real workerd against the loopback fake: fallback chain,
per-attempt timeouts inside the step deadline, token accounting, wire format."""

import socket
import time
from collections.abc import Iterator
from email.utils import formatdate
from typing import Any

import pytest

from tests.fakes.server import FakeServer, Reply
from tests.runtime.clients_probe import start_probe
from tests.runtime.harness import Worker
from todofy.core.gemini_wire import user_turn
from todofy.core.prompts import SUMMARY_EMAIL

API_KEY = "fake-gemini-key"
MODELS = ["model-a", "model-b", "model-c"]
EMAIL_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash"]
TIMEOUT_MS = 1500


def path(model: str) -> str:
    return f"/v1beta/models/{model}:generateContent"


def answer(text: str, tokens: int = 0) -> Reply:
    body: dict[str, Any] = {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}}]}
    if tokens:
        body["usageMetadata"] = {"promptTokenCount": 1, "totalTokenCount": tokens}
    return Reply(200, body)


@pytest.fixture(scope="module")
def upstream() -> Iterator[FakeServer]:
    server = FakeServer()
    yield server
    server.close()


@pytest.fixture(scope="module")
def probe(tmp_path_factory: pytest.TempPathFactory, upstream: FakeServer) -> Iterator[Worker]:
    yield from start_probe(
        tmp_path_factory.mktemp("clients-gemini"),
        {
            "GEMINI_API_BASE": upstream.url,
            "GEMINI_API_KEY": API_KEY,
            "GEMINI_MODELS": ",".join(MODELS),
            "GEMINI_TIMEOUT_MS": str(TIMEOUT_MS),
        },
    )


@pytest.fixture
def fake(upstream: FakeServer) -> FakeServer:
    upstream.reset()
    return upstream


def generate(probe: Worker, budget_ms: int = 10_000, **args: Any) -> dict[str, Any]:
    args = {"system": SUMMARY_EMAIL, "user": "合成邮件正文", "budget_ms": budget_ms} | args
    response = probe.hooks.post("/gemini", json=args)
    assert response.status_code == 200, response.text
    return response.json()


def tried(fake: FakeServer) -> list[str]:
    return [r.path.split("/")[-1].removesuffix(":generateContent") for r in fake.received("POST")]


def test_first_model_answers_with_the_fenced_turn_and_the_key_in_a_header(probe, fake):
    fake.queue("POST", path("model-a"), answer("摘要", tokens=42))
    result = generate(probe, preface="正文不完整")
    assert (result["ok"], result["text"], result["model"], result["tokens"]) == (True, "摘要", "model-a", 42)

    [sent] = fake.received("POST")
    assert sent.headers["x-goog-api-key"] == API_KEY
    assert sent.headers["content-type"] == "application/json"
    assert not sent.query  # never ?key=
    assert sent.json() == {
        "systemInstruction": {"parts": [{"text": SUMMARY_EMAIL}]},
        "contents": [{"role": "user", "parts": [{"text": user_turn("合成邮件正文", "正文不完整")}]}],
    }


@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_model_specific_failures_fall_through_the_chain_and_tokens_add_up(probe, fake, models):
    chain = MODELS if models is None else models
    fake.queue("POST", path(chain[0]), answer("   ", tokens=5))  # empty output
    fake.queue("POST", path(chain[1]), Reply(503, {"error": {"code": 503}}))
    fake.queue("POST", path(chain[2]), answer("第三个模型", tokens=10))
    result = generate(probe, models=models)
    assert (result["ok"], result["text"], result["model"], result["tokens"]) == (True, "第三个模型", chain[2], 15)
    assert (result["prompt_tokens"], result["attempts"]) == (2, 3)
    assert tried(fake) == chain
    assert len({r.body for r in fake.received("POST")}) == 1  # the same request to every model


@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_retired_model_404_tries_the_next_model(probe, fake, models):
    chain = MODELS if models is None else models
    fake.queue("POST", path(chain[0]), Reply(404, {"error": {"code": 404}}))
    fake.queue("POST", path(chain[1]), answer("ok"))
    assert generate(probe, models=models)["model"] == chain[1]


@pytest.mark.parametrize("status", [400, 401, 403])
@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_rejections_that_fail_on_every_model_stop_the_chain(probe, fake, status, models):
    model = (MODELS if models is None else models)[0]
    fake.queue("POST", path(model), Reply(status, {"error": {"code": status}}))
    result = generate(probe, models=models)
    assert (result["ok"], result["code"], result["next_model"]) == (False, "llm_request_rejected", False)
    assert (result["model"], result["text"], result["attempts"]) == (model, "", 1)
    assert tried(fake) == [model]


@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_quota_on_every_model_is_llm_quota_with_retry_after_seconds(probe, fake, models):
    chain = MODELS if models is None else models
    for model in chain:
        fake.queue("POST", path(model), Reply(429, {"error": {"code": 429}}, {"retry-after": "7"}))
    result = generate(probe, models=models)
    assert (result["ok"], result["code"], result["model"], result["retry_after"]) == (False, "llm_quota", chain[2], 7)
    assert tried(fake) == chain


def test_quota_retry_after_as_http_date(probe, fake):
    fake.queue("POST", path("model-a"), Reply(500, {"error": {"code": 500}}))
    fake.queue("POST", path("model-b"), Reply(500, {"error": {"code": 500}}))
    later = formatdate(time.time() + 30, usegmt=True)
    fake.queue("POST", path("model-c"), Reply(429, {"error": {"code": 429}}, {"retry-after": later}))
    result = generate(probe)
    assert result["code"] == "llm_quota"
    assert 20 <= result["retry_after"] <= 31


@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_every_model_failing_is_summary_failed_from_the_last_model(probe, fake, models):
    chain = MODELS if models is None else models
    fake.default("POST", path(chain[0]), Reply(500, b"oops"))
    fake.default("POST", path(chain[1]), Reply(502, b"oops"))
    fake.default("POST", path(chain[2]), Reply(200, b"not json"))
    result = generate(probe, models=models)
    assert (result["ok"], result["code"], result["model"], result["tokens"]) == (False, "summary_failed", chain[2], 0)
    assert result["attempts"] == 3


@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_a_hanging_model_is_abandoned_at_the_model_timeout(probe, fake, models):
    chain = MODELS if models is None else models
    fake.queue("POST", path(chain[0]), Reply(hang=True))
    fake.queue("POST", path(chain[1]), answer("第二个模型", tokens=3))
    result = generate(probe, models=models)
    assert (result["ok"], result["model"], result["tokens"]) == (True, chain[1], 3)
    assert TIMEOUT_MS <= result["elapsed_ms"] < TIMEOUT_MS + 3000
    fake.wait_for(lambda: path(chain[0]) in fake.disconnects)


@pytest.mark.parametrize("models", [None, EMAIL_MODELS], ids=["default", "email"])
def test_the_step_deadline_caps_the_chain(probe, fake, models):
    chain = MODELS if models is None else models
    for model in chain:
        fake.queue("POST", path(model), Reply(hang=True))
    # 1.5 s on model-a leaves < 1 s: no second attempt is started.
    result = generate(probe, budget_ms=2200, models=models)
    assert (result["ok"], result["code"], result["model"]) == (False, "summary_failed", chain[0])
    assert tried(fake) == [chain[0]]
    assert result["elapsed_ms"] < 2200


def test_the_last_attempt_is_cut_to_the_remaining_deadline(probe, fake):
    for model in MODELS:
        fake.queue("POST", path(model), Reply(hang=True))
    result = generate(probe, budget_ms=2800)  # 1.5 s on model-a, then ~1.3 s on model-b
    assert tried(fake) == ["model-a", "model-b"]
    assert result["model"] == "model-b"
    assert 2800 - 100 <= result["elapsed_ms"] < 2800 + 1000


def test_no_time_left_sends_nothing(probe, fake):
    result = generate(probe, budget_ms=0)
    assert (result["ok"], result["code"], result["model"], result["tokens"]) == (False, "summary_failed", "model-a", 0)
    assert fake.received() == []


def test_structured_output_sends_mime_type_and_schema(probe, fake):
    schema = {
        "type": "ARRAY",
        "items": {"type": "OBJECT", "properties": {"rank": {"type": "INTEGER"}}, "required": ["rank"]},
    }
    fake.queue("POST", path("model-a"), answer('[{"rank": 1}]', tokens=9))
    result = generate(probe, response_schema=schema)
    assert result["text"] == '[{"rank": 1}]'
    assert fake.received("POST")[0].json()["generationConfig"] == {
        "responseMimeType": "application/json",
        "responseSchema": schema,
    }


def test_models_come_from_the_gemini_models_var(probe, fake):
    fake.queue("POST", path("only-model"), Reply(503, b""))
    result = generate(probe, vars={"GEMINI_MODELS": "only-model"})
    assert (result["model"], result["code"]) == ("only-model", "summary_failed")
    assert tried(fake) == ["only-model"]


def test_an_explicit_order_does_not_change_the_default_for_a_later_call(probe, fake):
    fake.queue("POST", path(EMAIL_MODELS[0]), answer("邮件摘要"))
    result = generate(probe, models=EMAIL_MODELS)
    assert (result["model"], result["attempts"]) == (EMAIL_MODELS[0], 1)
    fake.queue("POST", path(MODELS[0]), answer("日报"))
    assert generate(probe)["model"] == MODELS[0]
    assert tried(fake) == [EMAIL_MODELS[0], MODELS[0]]


def test_an_empty_explicit_order_sends_nothing(probe, fake):
    result = generate(probe, models=[])
    assert (result["ok"], result["model"], result["attempts"], result["tokens"]) == (False, "", 0, 0)
    assert fake.received() == []


def test_network_failure_tries_every_explicit_model(probe, fake):
    # A bound socket without listen refuses connections; no upstream request can be served.
    with socket.socket() as refusing:
        refusing.bind(("127.0.0.1", 0))
        result = generate(
            probe,
            models=EMAIL_MODELS,
            vars={"GEMINI_API_BASE": f"http://127.0.0.1:{refusing.getsockname()[1]}"},
        )
    assert (result["ok"], result["code"], result["model"], result["attempts"]) == (
        False,
        "summary_failed",
        EMAIL_MODELS[-1],
        3,
    )
    assert fake.received() == []
