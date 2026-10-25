"""Synthetic HTTP and SDK checks; no login or model request is made."""

import contextlib
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import codex_cli_bin
import httpx
from openai_codex.generated.v2_all import ThreadItem
from ziyixi_proto.codex.inference.v1.inference_pb import (
    CheckInferenceResponse,
    InferenceModel,
    RunInferenceRequest,
    RunInferenceResponse,
)
from ziyixi_proto.wire_json import from_wire

from codex_gateway._launch import runtime_environment
from codex_gateway.app import MAX_BODY_BYTES, create_app
from codex_gateway.runtime import MODEL, infer, runtime_config, runtime_overrides

PATH = "/api/codex/v1/inference:run"
BODY = {
    "instructions": "Classify the synthetic JSON input.",
    "input_json": '{"emails":[{"id":"synthetic1","body":"Private synthetic content"}]}',
    "output_schema_json": '{"type":"object","properties":{"items":{"type":"array"}},"required":["items"],"additionalProperties":false}',
}


class FakeTurn:
    def __init__(self, error=None, *, text='{"items": []}', tool=False):
        self.error = error
        self.interrupted = False
        self.result = SimpleNamespace(
            status=SimpleNamespace(value="completed"),
            final_response=text,
            items=[
                ThreadItem.model_validate(
                    {
                        "type": "userMessage",
                        "id": "synthetic-input",
                        "content": [{"type": "text", "text": BODY["input_json"]}],
                    }
                ),
                SimpleNamespace(type="commandExecution" if tool else "agentMessage"),
            ],
            usage=SimpleNamespace(
                total=SimpleNamespace(input_tokens=101, output_tokens=23)
            ),
        )

    async def run(self):
        if self.error:
            raise self.error
        return self.result

    async def interrupt(self):
        self.interrupted = True


class FakeSdk:
    Sandbox = SimpleNamespace(read_only="read-only")
    ApprovalMode = SimpleNamespace(deny_all="deny-all")
    CodexConfig = SimpleNamespace

    def __init__(self, turn=None, *, account_type="chatgpt", enabled_skill=False):
        self.turn = turn or FakeTurn()
        self.account_type = account_type
        self.enabled_skill = enabled_skill
        self.closed = False
        self.config = self.thread_args = self.turn_args = None
        self._client = self

    def AsyncCodex(self, config):
        self.config = config
        return self

    async def __aenter__(self):
        return self

    async def close(self):
        self.closed = True

    async def account(self, *, refresh_token):
        assert refresh_token is False
        return SimpleNamespace(
            account=SimpleNamespace(root=SimpleNamespace(type=self.account_type))
        )

    async def request(self, method, data, *, response_model):
        assert method == "skills/list"
        assert data["forceReload"] is True
        return SimpleNamespace(
            data=[
                SimpleNamespace(
                    cwd=data["cwds"][0],
                    errors=[],
                    skills=[SimpleNamespace(enabled=self.enabled_skill)],
                )
            ]
        )

    async def thread_start(self, **kwargs):
        self.thread_args = kwargs
        return SimpleNamespace(turn=self.start_turn)

    async def start_turn(self, text, **kwargs):
        self.turn_args = {"input": text, **kwargs}
        return self.turn


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="codex-gateway-test-")
        self.home = pathlib.Path(self.temp.name)
        self.environment = patch.dict(
            os.environ,
            {
                "CODEX_HOME": str(self.home),
                "CODEX_GATEWAY_TOKEN": "synthetic-inference-token",
            },
            clear=True,
        )
        self.environment.start()
        self.calls = []

        async def runner(request, home):
            self.calls.append((request, home))
            return RunInferenceResponse(
                model=MODEL,
                effort="medium",
                output_json='{"items": []}',
                input_tokens=101,
                output_tokens=23,
            )

        self.app = create_app(runner=runner)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        self.environment.stop()
        self.temp.cleanup()

    async def test_authentication_precedes_body_read(self):
        async def body():
            raise AssertionError("Unauthorized body was read")
            yield b""

        for headers in ({}, {"authorization": "Bearer wrong-synthetic-token"}):
            response = await self.client.post(PATH, content=body(), headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["error"]["status"], "UNAUTHENTICATED")
        self.assertEqual(self.calls, [])

    async def test_valid_request_uses_generated_wire_types(self):
        response = await self.client.post(
            PATH,
            json=BODY,
            headers={"authorization": "Bearer synthetic-inference-token"},
        )
        self.assertEqual(response.status_code, 200)
        typed = from_wire(RunInferenceResponse, response.json(), strict=True).message
        self.assertEqual(
            (typed.model, typed.effort, typed.input_tokens, typed.output_tokens),
            (MODEL, "medium", 101, 23),
        )
        self.assertEqual(self.calls[0], (RunInferenceRequest(**BODY), self.home))
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(
            (await self.client.get("/healthz")).json(),
            {
                "service": "codex-gateway",
                "status": "ok",
                "source_sha": None,
                "release_request_id": "",
            },
        )

    async def test_readonly_preflight_uses_the_same_auth_and_generated_contract(self):
        calls = []

        async def checker(home):
            calls.append(home)
            return CheckInferenceResponse(
                model=MODEL,
                effort="medium",
                authenticated=True,
                models=[
                    InferenceModel(id=MODEL, model=MODEL, supported_efforts=["medium"])
                ],
            )

        app = create_app(checker=checker)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            path = "/api/codex/v1/inference:check"
            denied = await client.post(path, json={})
            self.assertEqual(denied.status_code, 401)
            self.assertEqual(calls, [])
            headers = {"authorization": "Bearer synthetic-inference-token"}
            response = await client.post(path, json={}, headers=headers)
            self.assertEqual(response.status_code, 200)
            typed = from_wire(
                CheckInferenceResponse, response.json(), strict=True
            ).message
            self.assertTrue(typed.authenticated)
            self.assertEqual(typed.models[0].supported_efforts, ("medium",))
            self.assertEqual(calls, [self.home])
            invalid = await client.post(
                path, json={"instructions": "not a preflight field"}, headers=headers
            )
            self.assertEqual(invalid.status_code, 400)
            self.assertEqual(calls, [self.home])
            self.assertEqual(self.calls, [])

    async def test_health_uses_baked_source_identity_and_release_request_id(self):
        baked = self.home / "build-info.json"
        baked.write_text(json.dumps({"source_sha": "a" * 40}))
        request_id = "cd4e06d0-741c-4a36-9bfc-810cb887a54b"
        with (
            patch("codex_gateway.app.BUILD_INFO_FILE", baked),
            patch.dict(
                os.environ,
                {
                    "BUILD_SHA": "b" * 40,
                    "SOURCE_SHA": "c" * 40,
                    "CODEX_GATEWAY_RELEASE_REQUEST_ID": request_id,
                },
            ),
        ):
            app = create_app()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.get("/healthz")
            self.assertEqual(response.json()["source_sha"], "a" * 40)
            self.assertEqual(response.json()["release_request_id"], request_id)
            self.assertNotIn("b" * 40, response.text)
            self.assertNotIn("c" * 40, response.text)

    async def test_terminal_model_failure_keeps_typed_http_200_response(self):
        async def runner(request, home):
            return await infer(
                request,
                home,
                sdk=FakeSdk(
                    FakeTurn(RuntimeError("usage_limit Private synthetic content"))
                ),
            )

        app = create_app(runner=runner)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                PATH,
                json=BODY,
                headers={"authorization": "Bearer synthetic-inference-token"},
            )
        self.assertEqual(response.status_code, 200)
        typed = from_wire(RunInferenceResponse, response.json(), strict=True).message
        self.assertEqual(typed.error_code, "codex_quota")
        self.assertEqual(typed.output_json, "")
        self.assertNotIn("Private synthetic content", response.text)

    async def test_invalid_and_oversized_bodies_do_not_invoke_sdk(self):
        for raw in (
            b'{"instructions":"x","instructions":"y"}',
            b"{}",
            b"x" * (MAX_BODY_BYTES + 1),
        ):
            with self.subTest(size=len(raw)):
                response = await self.client.post(
                    PATH,
                    content=raw,
                    headers={
                        "authorization": "Bearer synthetic-inference-token",
                        "content-type": "application/json",
                    },
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.calls, [])

    async def test_fixed_model_effort_and_isolated_runtime_policy(self):
        sdk = FakeSdk()
        answer = await infer(RunInferenceRequest(**BODY), self.home, sdk=sdk)
        self.assertEqual(
            (answer.error_code, answer.input_tokens, answer.output_tokens),
            ("", 101, 23),
        )
        self.assertTrue(sdk.closed)
        self.assertEqual(sdk.thread_args["model"], MODEL)
        self.assertEqual(sdk.thread_args["model_provider"], "openai")
        self.assertEqual(sdk.thread_args["sandbox"], "read-only")
        self.assertEqual(sdk.thread_args["approval_mode"], "deny-all")
        self.assertTrue(sdk.thread_args["ephemeral"])
        self.assertEqual(
            sdk.thread_args["developer_instructions"], BODY["instructions"]
        )
        self.assertEqual(sdk.turn_args["effort"].value, "medium")
        self.assertEqual(
            sdk.turn_args["output_schema"], json.loads(BODY["output_schema_json"])
        )
        self.assertFalse(pathlib.Path(sdk.config.cwd).exists())
        overrides = set(sdk.config.config_overrides)
        for override in (
            'forced_login_method="chatgpt"',
            'web_search="disabled"',
            "mcp_servers={}",
            "features.shell_tool=false",
            "features.apps=false",
            "features.plugins=false",
            "features.browser_use=false",
            "features.computer_use=false",
            "features.multi_agent=false",
            "features.code_mode_host=false",
            "features.image_generation=false",
            "features.skill_search=false",
        ):
            self.assertIn(override, overrides)
            self.assertIn(override, sdk.config.launch_args_override)
        self.assertIn("skills.config=[", " ".join(overrides))

    async def test_sdk_user_message_is_input_and_preserves_the_valid_answer(self):
        sdk = FakeSdk()
        self.assertEqual(sdk.turn.result.items[0].root.type, "userMessage")
        answer = await infer(RunInferenceRequest(**BODY), self.home, sdk=sdk)
        self.assertEqual(answer.error_code, "")
        self.assertEqual(answer.output_json, '{"items": []}')

    async def test_explicit_model_is_used_without_changing_the_default(self):
        sdk = FakeSdk()
        answer = await infer(
            RunInferenceRequest(**BODY, model="gpt-6.1-sol"), self.home, sdk=sdk
        )
        self.assertEqual(sdk.thread_args["model"], "gpt-6.1-sol")
        self.assertEqual(answer.model, "gpt-6.1-sol")
        self.assertEqual(answer.error_code, "")
        self.assertEqual(MODEL, "gpt-6-sol")

    async def test_model_failures_are_safe_typed_results_without_content_in_logs(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            for error, code in (
                (RuntimeError("unauthorized Private synthetic content"), "codex_auth"),
                (RuntimeError("usage_limit Private synthetic content"), "codex_quota"),
                (TimeoutError("Private synthetic content"), "codex_timeout"),
                (RuntimeError("Private synthetic content"), "codex_unavailable"),
            ):
                with self.subTest(code=code):
                    sdk = FakeSdk(FakeTurn(error))
                    answer = await infer(
                        RunInferenceRequest(**BODY), self.home, sdk=sdk
                    )
                    self.assertEqual(answer.error_code, code)
                    self.assertEqual(answer.output_json, "")
                    self.assertTrue(sdk.closed)
                    if code == "codex_timeout":
                        self.assertTrue(sdk.turn.interrupted)
        self.assertEqual(output.getvalue(), "")

    async def test_rejected_login_directory_returns_only_configuration_code(self):
        marker = "Private synthetic configuration content"
        (self.home / "config.toml").write_text(marker)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            answer = await infer(RunInferenceRequest(**BODY), self.home, sdk=FakeSdk())
        self.assertEqual(answer.error_code, "codex_configuration")
        self.assertEqual(answer.output_json, "")
        self.assertNotIn(marker, repr(answer))
        self.assertNotIn(str(self.home), repr(answer))
        self.assertEqual(output.getvalue(), "")

    async def test_pre_model_failures_report_safe_stage_and_keep_auth_quota_priority(
        self,
    ):
        marker = "Private synthetic diagnostic /synthetic/login/path"
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            for method, error, code in (
                ("__aenter__", RuntimeError(marker), "codex_startup"),
                ("account", RuntimeError(marker), "codex_account"),
                ("request", ValueError(marker), "codex_skills"),
                ("__aenter__", RuntimeError("unauthorized " + marker), "codex_auth"),
                ("request", RuntimeError("usage_limit " + marker), "codex_quota"),
                ("request", TimeoutError(marker), "codex_timeout"),
            ):
                with self.subTest(method=method, code=code):
                    sdk = FakeSdk()
                    with patch.object(sdk, method, side_effect=error):
                        answer = await infer(
                            RunInferenceRequest(**BODY), self.home, sdk=sdk
                        )
                    self.assertEqual(answer.error_code, code)
                    self.assertEqual(answer.output_json, "")
                    self.assertNotIn(marker, repr(answer))
                    self.assertNotIn(str(self.home), repr(answer))
                    self.assertTrue(sdk.closed)
        self.assertEqual(output.getvalue(), "")

    async def test_non_subscription_auth_enabled_skills_or_tools_cannot_succeed(self):
        for sdk, code in (
            (FakeSdk(account_type="apikey"), "codex_auth"),
            (FakeSdk(enabled_skill=True), "codex_skills"),
            (FakeSdk(FakeTurn(text="invalid JSON")), "codex_bad_answer"),
            (FakeSdk(FakeTurn(text='{"invalid": NaN}')), "codex_bad_answer"),
            (FakeSdk(FakeTurn(tool=True)), "codex_bad_answer"),
        ):
            with self.subTest(code=code):
                answer = await infer(RunInferenceRequest(**BODY), self.home, sdk=sdk)
                self.assertEqual(answer.error_code, code)


class EnvironmentTests(unittest.TestCase):
    def test_pinned_runtime_accepts_and_disables_operational_features_offline(self):
        with tempfile.TemporaryDirectory(prefix="codex-gateway-features-") as directory:
            home = pathlib.Path(directory)
            overrides = runtime_overrides(home)
            command = [str(codex_cli_bin.bundled_codex_path())]
            for item in overrides:
                command.extend(["--config", item])
            command.extend(["features", "list"])
            result = subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
                env={"HOME": str(home), "CODEX_HOME": str(home), "PATH": os.defpath},
            )
            effective = {
                line.split()[0]: line.split()[-1]
                for line in result.stdout.splitlines()
                if line.strip()
            }
            for override in overrides:
                if override.startswith("features."):
                    feature = override.removeprefix("features.").split("=", 1)[0]
                    self.assertEqual(effective[feature], "false", feature)

    def test_final_exec_environment_excludes_api_keys_and_service_tokens(self):
        self.assertEqual(
            runtime_environment(
                {
                    "PATH": "/usr/bin",
                    "CODEX_HOME": "/login",
                    "OPENAI_API_KEY": "synthetic-api-key",
                    "CODEX_GATEWAY_TOKEN": "synthetic-inference-token",
                    "GITHUB_TOKEN": "synthetic-github-token",
                }
            ),
            {"PATH": "/usr/bin", "CODEX_HOME": "/login"},
        )
        config = runtime_config(
            FakeSdk(), pathlib.Path("/login"), pathlib.Path("/tmp/workspace")
        )
        self.assertEqual(config.env, {"CODEX_HOME": "/login"})


if __name__ == "__main__":
    unittest.main()
