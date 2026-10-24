import asyncio
import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from ziyixi_proto.mailsort.runner.v1 import mailsort_runner_service_pb as api
from ziyixi_proto.wire_json import from_wire, to_wire

from mailsort_runner import classifier, runner, runtime
from mailsort_runner.api import Client
from mailsort_runner.settings import EFFORT, MODEL, RunnerError, Settings
from mailsort_runner.usage import Usage

NOW = "2026-10-24T12:00:00Z"


def message(index):
    return api.ClassificationMessage(
        message_id=f"m{index}",
        thread_id=f"t{index}",
        received_at=NOW,
        time_zone="America/Los_Angeles",
        subject="合成私密主题",
        body="合成私密正文",
        body_truncated=True,
        sender="合成发件人",
    )


def answer(messages):
    return {
        "items": [
            {"id": item.message_id, "bucket": "P4", "reason": "合成回执留待查询。"}
            for item in messages
        ]
    }


def fake_sdk(messages, *, completed=True, provider_error=None):
    calls = []

    class Payload:
        def __init__(self, value):
            self.value = value

        def model_dump(self, **kwargs):
            return self.value

    class Turn:
        thread_id, id = "test-thread", "test-turn"

        async def stream(self):
            for count in (20, 40, 40):
                yield SimpleNamespace(
                    method="thread/tokenUsage/updated",
                    payload=Payload(
                        {
                            "threadId": self.thread_id,
                            "turnId": self.id,
                            "tokenUsage": {"total": {"inputTokens": count, "outputTokens": 10}},
                        }
                    ),
                )
            yield SimpleNamespace(
                method="item/completed",
                payload=Payload(
                    {
                        "item": {
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": json.dumps(answer(messages)),
                        },
                    }
                ),
            )
            yield SimpleNamespace(
                method="turn/completed",
                payload=Payload(
                    {
                        "turn": {
                            "status": "completed" if completed else "failed",
                            "error": provider_error,
                        },
                    }
                ),
            )

    class Thread:
        def __init__(self, client, thread_id):
            assert thread_id == "test-thread"

        async def turn(self, text, **kwargs):
            calls.append((json.loads(text), kwargs))
            return Turn()

    class Codex:
        def __init__(self, config):
            self.config = config
            self._client = self
            self.started = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def account(self, **kwargs):
            return SimpleNamespace(account=SimpleNamespace(root=SimpleNamespace(type="chatgpt")))

        async def thread_start(self, params):
            self.started.append(params)
            assert params.ephemeral and params.model == MODEL
            assert params.config == {"model_reasoning_effort": EFFORT}
            assert params.developer_instructions == classifier.PROMPT
            import openai_codex.generated.v2_all as v2

            return SimpleNamespace(
                model=MODEL,
                reasoning_effort=v2.ReasoningEffort.medium,
                thread=SimpleNamespace(id="test-thread"),
            )

    return SimpleNamespace(
        AsyncCodex=Codex, AsyncThread=Thread, CodexConfig=lambda **kw: SimpleNamespace(**kw)
    ), calls


def transport_for(messages, reports):
    def handle(request):
        assert request.headers["Authorization"] == "Bearer synthetic-machine-token"
        body = json.loads(request.content)
        if request.url.path.endswith(":claim"):
            typed = from_wire(api.ClaimClassificationRequest, body, strict=True).message
            offset = int(typed.page_token or "0")
            page = api.ClaimClassificationResponse(
                run_id=typed.run_id,
                evaluated_at=NOW,
                messages=messages[offset : offset + 10],
                next_page_token=str(offset + 10) if offset + 10 < len(messages) else "",
            )
            return httpx.Response(200, json=to_wire(page))
        assert request.url.path.endswith(":report")
        typed = from_wire(api.ReportClassificationRequest, body, strict=True).message
        reports.append(typed)
        return httpx.Response(
            200,
            json=to_wire(
                api.ReportClassificationResponse(
                    accepted_count=len(typed.results),
                    pending_write_count=len(typed.results),
                )
            ),
        )

    return httpx.MockTransport(handle)


def test_all_pages_use_one_medium_turn_and_complete_report(tmp_path, capsys):
    messages = tuple(message(index) for index in range(100))
    sdk, calls = fake_sdk(messages)
    reports = []
    settings = Settings("https://synthetic.invalid", "synthetic-machine-token", tmp_path)
    client = Client(settings, transport=transport_for(messages, reports))

    async def classify(*args):
        return await classifier.classify(*args, sdk=sdk)

    assert asyncio.run(runner.run(client, settings, classify=classify)) == 0
    client.close()
    assert len(calls) == 1
    assert len(calls[0][0]["emails"]) == 100
    assert all(item["evaluated_at"] == NOW for item in calls[0][0]["emails"])
    assert all(item["time_zone"] == "America/Los_Angeles" for item in calls[0][0]["emails"])
    assert all(item["body_truncated"] is True for item in calls[0][0]["emails"])
    assert calls[0][1]["effort"].value == "medium"
    assert reports[0].status == api.RunStatus.RUNNING
    report = reports[-1]
    assert report.status == api.RunStatus.COMPLETED
    assert len(report.results) == 100
    assert report.input_tokens == 40 and report.output_tokens == 10
    assert not report.usage_partial
    assert all(item.priority == api.Priority.P4 for item in report.results)
    log = capsys.readouterr().out
    for private in (
        "合成私密主题",
        "合成私密正文",
        "合成发件人",
        "合成回执",
        "synthetic-machine-token",
    ):
        assert private not in log


def test_empty_batch_reports_completion_without_model(tmp_path):
    reports = []
    settings = Settings("https://synthetic.invalid", "synthetic-machine-token", tmp_path)
    client = Client(settings, transport=transport_for((), reports))

    async def never(*args):
        pytest.fail("An empty run must not call the SDK")

    assert asyncio.run(runner.run(client, settings, classify=never)) == 0
    client.close()
    assert len(reports) == 1 and reports[0].status == api.RunStatus.COMPLETED
    assert reports[0].input_tokens is None and not reports[0].usage_partial


def test_model_failure_reports_partial_usage_without_output(tmp_path, capsys):
    messages = (message(1),)
    sdk, calls = fake_sdk(
        messages,
        completed=False,
        provider_error={
            "message": "synthetic private error",
            "codexErrorInfo": "usageLimitExceeded",
        },
    )
    reports = []
    settings = Settings("https://synthetic.invalid", "synthetic-machine-token", tmp_path)
    client = Client(settings, transport=transport_for(messages, reports))

    async def classify(*args):
        return await classifier.classify(*args, sdk=sdk)

    assert asyncio.run(runner.run(client, settings, classify=classify)) == 1
    client.close()
    assert len(calls) == 1
    assert reports[-1].status == api.RunStatus.FAILED
    assert reports[-1].error_code == "codex_quota_exhausted"
    assert reports[-1].results == ()
    assert reports[-1].input_tokens == 40 and reports[-1].usage_partial
    assert "synthetic private error" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "items",
    [
        [],
        [{"id": "m1", "bucket": "P4", "reason": "合成。"}] * 2,
        [
            {"id": "m1", "bucket": "P5", "reason": "合成。"},
            {"id": "m2", "bucket": "P4", "reason": "合成。"},
        ],
        [
            {"id": "m1", "bucket": "P4", "reason": ""},
            {"id": "m2", "bucket": "P4", "reason": "合成。"},
        ],
        [
            {"id": "m1", "bucket": "P4", "reason": "合成。"},
            {"id": "other", "bucket": "P4", "reason": "合成。"},
        ],
    ],
)
def test_model_output_must_cover_exactly_every_input(items):
    with pytest.raises(RunnerError, match="codex_failed"):
        classifier.parse_results(json.dumps({"items": items}), (message(1), message(2)))


def test_input_order_retained_when_model_reorders():
    messages = (message(1), message(2))
    payload = answer(tuple(reversed(messages)))
    assert [
        item.message_id for item in classifier.parse_results(json.dumps(payload), messages)
    ] == ["m1", "m2"]


def test_duplicate_claimed_ids_fail_without_model(tmp_path):
    class DuplicateClient:
        def __init__(self):
            self.reports = []

        def claim(self, run_id, token):
            return api.ClaimClassificationResponse(
                run_id=run_id, evaluated_at=NOW, messages=(message(1), message(1))
            )

        def report(self, report):
            self.reports.append(report)
            return api.ReportClassificationResponse()

    client = DuplicateClient()
    assert (
        asyncio.run(runner.run(client, Settings("https://synthetic.invalid", "token", tmp_path)))
        == 1
    )
    assert client.reports[-1].error_code == "claim_failed"


def test_usage_replaces_snapshot_and_ignores_unrelated_and_decreasing_events():
    usage = Usage()
    payload = {
        "threadId": "t",
        "turnId": "r",
        "tokenUsage": {"total": {"inputTokens": 40, "outputTokens": 10}},
    }
    usage.observe(payload, "t", "r")
    usage.observe(payload, "t", "r")
    usage.observe(payload, "other", "r")
    usage.observe(
        {**payload, "tokenUsage": {"total": {"inputTokens": 10, "outputTokens": 5}}}, "t", "r"
    )
    usage.finish(True)
    assert (usage.input_tokens, usage.output_tokens, usage.partial) == (40, 10, True)


def test_http_failure_never_surfaces_response_or_token(tmp_path):
    settings = Settings("https://synthetic.invalid", "synthetic-machine-token", tmp_path)
    client = Client(
        settings,
        transport=httpx.MockTransport(lambda request: httpx.Response(403, text="private body")),
    )
    with pytest.raises(RunnerError, match="claim_failed") as error:
        client.claim(str(uuid.uuid4()))
    client.close()
    assert "private body" not in str(error.value) and "synthetic-machine-token" not in repr(
        settings
    )


def test_model_process_environment_removes_machine_token(monkeypatch, tmp_path):
    from mailsort_runner import _runtime

    monkeypatch.setenv("MAILSORT_TOKEN", "synthetic-private-token")
    monkeypatch.setenv("MAILSORT_TOKEN_FILE", "/private/secret/token")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-api-key")
    monkeypatch.setenv("HTTP_PROXY", "https://proxy.invalid")
    sdk, _ = fake_sdk(())
    configuration = runtime.config(sdk, tmp_path / "auth", tmp_path / "workspace")
    final = _runtime.runtime_environment(configuration.env)
    assert "MAILSORT_TOKEN" not in final and "MAILSORT_TOKEN_FILE" not in final
    assert "OPENAI_API_KEY" not in final and "HTTP_PROXY" not in final
    assert "synthetic-private-token" not in json.dumps(configuration.env)
    assert final["CODEX_HOME"] == str(tmp_path / "auth")
    assert final["HOME"] == str(tmp_path / "workspace")
    assert 'web_search="disabled"' in configuration.config_overrides
    for tool in ("shell_tool", "apps", "plugins", "code_mode_host"):
        assert f"features.{tool}=false" in configuration.config_overrides


def test_settings_secret_file_and_https_origin(monkeypatch, tmp_path):
    monkeypatch.setenv("MAILSORT_URL", "https://synthetic.invalid")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.delenv("MAILSORT_TOKEN", raising=False)
    token_file = tmp_path / "machine-token"
    token_file.write_text("synthetic-token\n")
    monkeypatch.setenv("MAILSORT_TOKEN_FILE", str(token_file))
    assert Settings.from_environment().token == "synthetic-token"
    monkeypatch.setenv("MAILSORT_URL", "http://synthetic.invalid")
    with pytest.raises(RunnerError, match="configuration"):
        Settings.from_environment()


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        ({"codexErrorInfo": "unauthorized"}, "codex_not_logged_in"),
        ({"message": 'provider error: "code":"model_not_found"'}, "codex_model_unavailable"),
        ({"codexErrorInfo": "usageLimitExceeded"}, "codex_quota_exhausted"),
        ({"message": "synthetic private response"}, "codex_failed"),
    ],
)
def test_safe_provider_error_mapping(error, expected):
    assert classifier.provider_error(error) == expected
