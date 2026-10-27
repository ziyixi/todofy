"""Common model client in real workerd through a test-only service binding."""

from collections.abc import Iterator

import pytest

from tests.fakes.model_router_fake import GENERATE_PATH, ModelRouterFake, error_reply, text_reply
from tests.fakes.server import Reply
from tests.runtime.clients_probe import start_probe
from tests.runtime.harness import Worker
from todofy.core.model_input import user_turn
from todofy.core.prompts import SUMMARY_EMAIL


@pytest.fixture(scope="module")
def upstream() -> Iterator[ModelRouterFake]:
    server = ModelRouterFake()
    yield server
    server.close()


@pytest.fixture(scope="module")
def probe(tmp_path_factory: pytest.TempPathFactory, upstream: ModelRouterFake) -> Iterator[Worker]:
    yield from start_probe(tmp_path_factory.mktemp("clients-model"), {"MODEL_ROUTER_FAKE_ORIGIN": upstream.url})


@pytest.fixture
def fake(upstream: ModelRouterFake) -> ModelRouterFake:
    upstream.reset()
    return upstream


def generate(probe: Worker, budget_ms: int = 10000, **args) -> dict:
    response = probe.hooks.post(
        "/model", json={"system": SUMMARY_EMAIL, "user": "合成邮件正文", "budget_ms": budget_ms} | args
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_common_wire_preserves_prompt_framing_and_usage(probe: Worker, fake: ModelRouterFake):
    fake.queue_generate(text_reply("摘要", tokens=42))
    result = generate(probe, preface="正文不完整")
    assert (result["ok"], result["text"], result["tokens"], result["attempts"]) == (True, "摘要", 42, 1)
    assert result["usage_available"]
    [sent] = fake.received("POST", GENERATE_PATH)
    body = sent.json()
    assert body["config"]["model"] == "models/gemini-email"
    assert body["config"]["instructions"] == [{"text": SUMMARY_EMAIL, "cache": True}]
    assert body["input"] == user_turn("合成邮件正文", "正文不完整")
    assert "x-goog-api-key" not in sent.headers and not sent.query


def test_router_fallback_is_one_call_with_aggregate_attempt_metadata(probe: Worker, fake: ModelRouterFake):
    fake.queue_generate(text_reply("Final", tokens=73, model="reported-fallback", attempts=3))
    result = generate(probe)
    assert (result["ok"], result["model"], result["tokens"], result["attempts"]) == (True, "reported-fallback", 73, 3)
    assert len(fake.calls()) == 1


@pytest.mark.parametrize(
    "status,code",
    [
        (400, "llm_request_rejected"),
        (401, "llm_request_rejected"),
        (403, "llm_request_rejected"),
        (429, "llm_quota"),
        (500, "summary_failed"),
    ],
)
def test_normalized_errors_keep_business_classification(probe: Worker, fake: ModelRouterFake, status: int, code: str):
    fake.queue_generate(error_reply(status, {"retry-after": "7"}))
    result = generate(probe)
    assert result["ok"] is False and result["code"] == code
    assert result["attempts"] == 1 and len(fake.calls()) == 1
    if status == 429:
        assert result["retry_after"] == 7


def test_unknown_usage_is_explicit_and_not_a_known_zero(probe: Worker, fake: ModelRouterFake):
    fake.queue_generate(
        Reply(200, {"state": "succeeded", "output": "synthetic", "usage": {"available": False}, "attempt_count": 1})
    )
    result = generate(probe)
    assert result["ok"] and not result["usage_available"]


def test_standard_json_schema_remains_provider_neutral(probe: Worker, fake: ModelRouterFake):
    schema = {
        "type": "array",
        "items": {"type": "object", "properties": {"rank": {"type": "integer"}}, "required": ["rank"]},
    }
    fake.queue_generate(text_reply('[{"rank":1}]'))
    assert generate(probe, response_schema=schema)["ok"]
    assert fake.calls()[0].response_schema == schema


def test_explicit_public_model_is_sent_without_local_fallback_policy(probe: Worker, fake: ModelRouterFake):
    fake.queue_generate(text_reply("synthetic"))
    generate(probe, model="models/sol-6-1")
    assert [call.requested_model for call in fake.calls()] == ["models/sol-6-1"]


def test_no_time_left_does_not_invoke_the_router(probe: Worker, fake: ModelRouterFake):
    result = generate(probe, budget_ms=0)
    assert not result["ok"] and result["attempts"] == 0
    assert fake.calls() == []


def test_hanging_binding_is_cancelled_at_the_step_deadline(probe: Worker, fake: ModelRouterFake):
    fake.queue_generate(Reply(hang=True))
    result = generate(probe, budget_ms=1500)
    assert not result["ok"] and result["elapsed_ms"] < 4000
    fake.wait_for(lambda: GENERATE_PATH in fake.disconnects)
