"""Synthetic slim HTTP transport and pinned runtime configuration checks."""

import asyncio
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

import codex_cli_bin
import httpx
from auth_fixtures import AUDIENCE, ISSUER, access_headers, local_jwks, verifier
from model_fixtures import FakeSdk, FakeTurn, StubExecutor
from ziyixi_proto.modelrouter.inference.v1.inference_pb import Generation
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import from_wire

from codex_gateway._launch import runtime_environment
from codex_gateway.app import MAX_BODY_BYTES, create_app
from codex_gateway.model_api import result_events
from codex_gateway.modelrouter import ModelExecutor
from codex_gateway.runtime import MODEL, runtime_config, runtime_overrides

PATH = "/api/codex/v1/model/generations:generate"
BODY = {
    "model": MODEL,
    "input": "Synthetic JSON input",
    "output_schema_json": '{"type":"object"}',
}


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gateway-http-test-")
        self.home = pathlib.Path(self.temp.name)
        self.environment = patch.dict(
            os.environ, {"CODEX_HOME": str(self.home)}, clear=True
        )
        self.environment.start()
        self.jwks = local_jwks()
        self.jwks.start()
        self.executor = StubExecutor()
        self.app = create_app(model_executor=self.executor, access_verifier=verifier())
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        self.jwks.stop()
        self.environment.stop()
        self.temp.cleanup()

    async def test_slim_json_and_private_alias_use_the_generated_contract(self):
        first = await self.client.post(PATH, json=BODY, headers=access_headers())
        second = await self.client.post(
            "/api/model/v1/generations:generate", json=BODY, headers=access_headers()
        )
        self.assertEqual(first.status_code, 200)
        answer = from_wire(Generation, first.json(), strict=True).message
        self.assertEqual(answer.model, MODEL)
        self.assertEqual(answer.output, '{"items":[]}')
        self.assertNotEqual(answer.name, second.json()["name"])
        self.assertEqual(len(self.executor.calls), 2)
        self.assertEqual(self.executor.calls[0][0].input, BODY["input"])
        self.assertEqual(first.headers["cache-control"], "no-store")
        self.assertNotIn("state", first.json())
        self.assertNotIn("reported_model", first.json())

    async def test_removed_legacy_and_context_read_routes_are_absent(self):
        for path in ("/api/codex/v1/inference:run", "/api/codex/v1/inference:check"):
            self.assertEqual(
                (
                    await self.client.post(path, json={}, headers=access_headers())
                ).status_code,
                404,
            )
        self.assertEqual(
            (
                await self.client.get(
                    "/api/codex/v1/model/conversations/synthetic",
                    headers=access_headers(),
                )
            ).status_code,
            404,
        )

    async def test_metadata_catalog_has_only_the_actual_native_model(self):
        response = await self.client.get(
            "/api/codex/v1/model/models", headers=access_headers()
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.json()["models"]], [MODEL])
        self.assertEqual(self.executor.calls, [])

    async def test_invalid_fields_and_json_are_rejected_before_execution(self):
        bodies = [
            {**BODY, "request_id": "obsolete"},
            {**BODY, "config": {}},
            {**BODY, "input": 1},
            {**BODY, "model": "gpt-6-astra"},
            {**BODY, "max_output_tokens": 1},
            {**BODY, "timeout_ms": 840001},
            {**BODY, "output_schema_json": "invalid json"},
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(
                    (
                        await self.client.post(
                            PATH, json=body, headers=access_headers()
                        )
                    ).status_code,
                    400,
                )
        for raw in (
            '{"model":"gpt-6.1-sol","input":"a","input":"b"}',
            '{"timeout_ms":NaN}',
        ):
            response = await self.client.post(
                PATH,
                content=raw,
                headers={**access_headers(), "content-type": "application/json"},
            )
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.executor.calls, [])

    async def test_media_type_and_utf8_wire_size_are_bounded(self):
        for content_type in ("text/plain", ""):
            response = await self.client.post(
                PATH,
                content=b"{}",
                headers={**access_headers(), "content-type": content_type},
            )
            self.assertEqual(response.status_code, 400)
        response = await self.client.post(
            PATH,
            content=b"x" * (MAX_BODY_BYTES + 1),
            headers={**access_headers(), "content-type": "application/json"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.executor.calls, [])

    async def test_health_is_liveness_with_baked_release_identity_only(self):
        response = await self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            set(response.json()),
            {"service", "status", "source_sha", "release_request_id"},
        )
        self.assertEqual(response.json()["service"], "codex-gateway")
        info = self.home / "build-info.json"
        info.write_text(json.dumps({"source_sha": "a" * 40}))
        with (
            patch("codex_gateway.app.BUILD_INFO_FILE", info),
            patch.dict(
                os.environ, {"CODEX_GATEWAY_RELEASE_REQUEST_ID": "synthetic-release"}
            ),
        ):
            app = create_app(model_executor=StubExecutor(), access_verifier=verifier())
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                health = (await client.get("/healthz")).json()
        self.assertEqual(health["source_sha"], "a" * 40)
        self.assertEqual(health["release_request_id"], "synthetic-release")

    async def test_sse_is_private_final_result_transport(self):
        response = await self.client.post(
            PATH, json=BODY, headers={**access_headers(), "accept": "text/event-stream"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])
        self.assertIn("event: ready", response.text)
        self.assertIn("event: result", response.text)
        self.assertNotIn("delta", response.text)
        self.assertIn(MODEL, response.text)

    async def test_context_create_two_turns_and_close_use_empty_acknowledgements(self):
        sdk = FakeSdk(FakeTurn(1), FakeTurn(2))
        executor = ModelExecutor(sdk=sdk)
        name = f"conversations/{uuid.uuid4()}"
        app = create_app(model_executor=executor, access_verifier=verifier())
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                created = await client.post(
                    "/api/codex/v1/model/conversations",
                    json={"name": name, "model": MODEL, "web_research": True},
                    headers={**access_headers(), "accept": "text/event-stream"},
                )
                self.assertEqual(created.status_code, 200)
                self.assertIn("event: result\ndata: {}", created.text)
                workspace = pathlib.Path(executor.contexts[name].directory.name)
                for text in ("first", "correction"):
                    result = await client.post(
                        PATH,
                        json={"conversation": name, "input": text},
                        headers=access_headers(),
                    )
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.json()["usage"]["input_tokens"], 101)
                for _ in range(2):
                    closed = await client.post(
                        f"/api/codex/v1/model/{name}:close",
                        json={},
                        headers=access_headers(),
                    )
                    self.assertEqual(closed.status_code, 200)
                    self.assertEqual(closed.json(), {})
                self.assertTrue(sdk.closed)
                self.assertFalse(workspace.exists())
        finally:
            await executor.shutdown()

    async def test_heartbeat_error_and_disconnect_wait_for_operation_cleanup(self):
        async def slow():
            await asyncio.sleep(0.005)
            return None

        with patch("codex_gateway.model_api.HEARTBEAT_SECONDS", 0.001):
            frames = [frame async for frame in result_events(slow())]
        self.assertTrue(any("event: heartbeat" in frame for frame in frames))
        self.assertEqual(frames[-1], "event: result\ndata: {}\n\n")

        async def error():
            raise RpcError("UNAVAILABLE", "MODEL_UNAVAILABLE", "Safe failure")

        frames = [frame async for frame in result_events(error())]
        self.assertIn("event: error", frames[-1])
        cleaned = asyncio.Event()
        started = asyncio.Event()

        async def blocked():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        stream = result_events(blocked())
        await anext(stream)
        await started.wait()
        await stream.aclose()
        self.assertTrue(cleaned.is_set())


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
                    "ACCESS_ISSUER": ISSUER,
                    "ACCESS_AUDIENCE": AUDIENCE,
                    "GITHUB_TOKEN": "synthetic-github-token",
                }
            ),
            {"PATH": "/usr/bin", "CODEX_HOME": "/login"},
        )
        config = runtime_config(
            FakeSdk(), pathlib.Path("/login"), pathlib.Path("/tmp/workspace")
        )
        self.assertEqual(config.env, {"CODEX_HOME": "/login"})
