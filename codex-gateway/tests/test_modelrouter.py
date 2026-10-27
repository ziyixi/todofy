"""Synthetic short-context, hosted-web, usage and cleanup acceptance."""

import asyncio
import dataclasses
import json
import os
import pathlib
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from auth_fixtures import access_headers, local_jwks, verifier
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    Conversation,
    CreateConversationRequest,
    GenerateRequest,
    GenerationConfig,
    Instruction,
    Parameters,
)
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import to_wire

from codex_gateway.app import create_app
from codex_gateway.model_api import result_events
from codex_gateway.modelrouter import ModelExecutor


def identifier() -> str:
    return str(uuid.uuid4())


def config(**kwargs) -> GenerationConfig:
    return GenerationConfig(
        model="models/sol-6-1",
        instructions=(Instruction(text="Synthetic instruction", cache=True),),
        **kwargs,
    )


class FakeTurn:
    def __init__(self, number, *, block=False, tools=(), usage=True, output="answer"):
        self.id = f"turn-{number}"
        self.thread_id = "synthetic-thread"
        self.number = number
        self.block = block
        self.tools = tools
        self.has_usage = usage
        self.output = output
        self.interrupted = False

    async def interrupt(self):
        self.interrupted = True

    async def stream(self):
        if self.block:
            await asyncio.Event().wait()
        if self.has_usage:
            yield SimpleNamespace(
                method="thread/tokenUsage/updated",
                payload={
                    "turnId": self.id,
                    "threadId": self.thread_id,
                    "tokenUsage": {
                        "total": {
                            "inputTokens": self.number * 101,
                            "outputTokens": self.number * 21,
                            "cachedInputTokens": self.number * 50,
                            "cacheWriteInputTokens": 0,
                            "reasoningOutputTokens": self.number * 11,
                            "totalTokens": self.number * 122,
                        }
                    },
                },
            )
        for tool in self.tools:
            yield SimpleNamespace(method="item/completed", payload={"item": tool})
        yield SimpleNamespace(
            method="item/completed",
            payload={
                "item": {
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": self.output,
                }
            },
        )
        yield SimpleNamespace(
            method="turn/completed", payload={"turn": {"status": "completed"}}
        )


class FakeSdk:
    Sandbox = SimpleNamespace(read_only="read-only")
    ApprovalMode = SimpleNamespace(deny_all="deny-all")
    CodexConfig = SimpleNamespace

    def __init__(self, *turns):
        self.turns = list(turns)
        self.calls = []
        self.started = 0
        self.closed = False
        self.close_started = asyncio.Event()
        self.allow_close = asyncio.Event()
        self.allow_close.set()
        self._client = self

    def AsyncCodex(self, config):
        self.config = config
        return self

    async def __aenter__(self):
        return self

    async def close(self):
        self.close_started.set()
        await self.allow_close.wait()
        self.closed = True

    async def account(self, *, refresh_token):
        return SimpleNamespace(
            account=SimpleNamespace(root=SimpleNamespace(type="chatgpt"))
        )

    async def request(self, method, data, *, response_model):
        return SimpleNamespace(
            data=[SimpleNamespace(cwd=data["cwds"][0], errors=[], skills=[])]
        )

    async def thread_start(self, **kwargs):
        self.started += 1
        self.thread_options = kwargs
        return SimpleNamespace(turn=self.turn)

    async def turn(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return self.turns.pop(0)


class ModelRouterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="executor-test-")
        self.home = pathlib.Path(self.temp.name)
        self.executors = []
        self.jwks_mock = local_jwks()
        self.jwks_mock.start()

    async def asyncTearDown(self):
        for executor in self.executors:
            await executor.shutdown()
        self.temp.cleanup()
        self.jwks_mock.stop()

    def executor(self, sdk):
        executor = ModelExecutor(self.home / "monitor.sqlite3", sdk=sdk)
        self.executors.append(executor)
        return executor

    async def create(self, executor, settings=None, timeout_ms=0):
        return await executor.create(
            CreateConversationRequest(
                request_id=identifier(),
                conversation=Conversation(
                    name=f"conversations/{identifier()}",
                    config=settings or config(),
                    timeout_ms=timeout_ms,
                ),
            ),
            self.home,
        )

    async def test_two_turns_reuse_thread_and_normalize_snapshot_deltas(self):
        sdk = FakeSdk(FakeTurn(1), FakeTurn(2))
        executor = self.executor(sdk)
        conversation = await self.create(executor)
        outputs = []
        for text in ("first synthetic turn", "second synthetic turn"):
            outputs.append(
                await executor.generate(
                    GenerateRequest(
                        request_id=identifier(),
                        conversation=conversation.name,
                        input=text,
                    ),
                    self.home,
                )
            )
        self.assertEqual(sdk.started, 1)
        self.assertFalse(sdk.closed)
        self.assertEqual([value.usage.input_tokens for value in outputs], [101, 101])
        self.assertEqual(outputs[1].usage.cached_input_tokens, 50)
        self.assertEqual(outputs[1].usage.reasoning_output_tokens, 11)
        self.assertTrue(all(value.usage.available for value in outputs))
        self.assertEqual(outputs[0].reported_model, "")
        self.assertTrue(outputs[0].upstream_started)
        self.assertEqual(outputs[0].attempt_count, 1)
        self.assertEqual(outputs[0].finish_reason, "complete")
        self.assertNotIn("effort", sdk.calls[0][1])
        self.assertEqual(
            (await executor.get(conversation.name)).expire_time,
            conversation.expire_time,
        )

    async def test_actual_web_actions_are_observed_and_text_claims_are_ignored(self):
        sdk = FakeSdk(
            FakeTurn(
                1,
                tools=(
                    {
                        "type": "webSearch",
                        "action": {"type": "search", "query": "synthetic"},
                    },
                    {
                        "type": "webSearch",
                        "action": {
                            "type": "openPage",
                            "url": "https://example.test/a#part",
                        },
                    },
                ),
                output="I also opened https://example.test/not-observed",
            )
        )
        executor = self.executor(sdk)
        result = await executor.generate(
            GenerateRequest(
                request_id=identifier(),
                config=config(
                    web_research=True, parameters=Parameters(effort="medium")
                ),
                input="synthetic",
            ),
            self.home,
        )
        self.assertEqual(result.state, "succeeded")
        self.assertTrue(result.observations.searched)
        self.assertEqual(
            result.observations.opened_urls, ("https://example.test/a#part",)
        )
        self.assertEqual(sdk.calls[0][1]["effort"].value, "medium")
        self.assertIn('web_search="live"', sdk.config.config_overrides)
        self.assertIn("features.code_mode_host=true", sdk.config.config_overrides)
        self.assertIn("features.shell_tool=false", sdk.config.config_overrides)
        self.assertTrue(sdk.closed)
        self.assertFalse(pathlib.Path(sdk.config.cwd).exists())

    async def test_unknown_usage_remains_unavailable_on_next_cumulative_snapshot(self):
        sdk = FakeSdk(FakeTurn(1, usage=False), FakeTurn(2))
        executor = self.executor(sdk)
        conversation = await self.create(executor)
        for _ in range(2):
            answer = await executor.generate(
                GenerateRequest(
                    request_id=identifier(),
                    conversation=conversation.name,
                    input="synthetic",
                ),
                self.home,
            )
            self.assertFalse(answer.usage.available)

    async def test_missing_middle_snapshot_is_not_charged_to_the_following_call(self):
        executor = self.executor(
            FakeSdk(FakeTurn(1), FakeTurn(2, usage=False), FakeTurn(3), FakeTurn(4))
        )
        conversation = await self.create(executor)
        answers = []
        for _ in range(4):
            answers.append(
                await executor.generate(
                    GenerateRequest(
                        request_id=identifier(),
                        conversation=conversation.name,
                        input="synthetic",
                    ),
                    self.home,
                )
            )
        self.assertEqual(
            [answer.usage.available for answer in answers], [True, False, False, True]
        )
        self.assertEqual(answers[3].usage.input_tokens, 101)

    async def test_close_waits_for_cleanup_then_receipt_survives_restart(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        conversation = await self.create(executor)
        sdk.allow_close.clear()
        task = asyncio.create_task(executor.close(conversation.name, identifier()))
        await sdk.close_started.wait()
        self.assertFalse(task.done())
        self.assertEqual(executor.store.get(conversation.name).state, "open")
        self.assertTrue(pathlib.Path(sdk.config.cwd).exists())
        sdk.allow_close.set()
        receipt = await task
        self.assertEqual(receipt.state, "closed")
        self.assertFalse(pathlib.Path(sdk.config.cwd).exists())
        restarted = self.executor(FakeSdk())
        self.assertEqual(
            (await restarted.close(conversation.name, identifier())).state, "closed"
        )
        self.assertNotIn(
            "Synthetic instruction",
            (self.home / "monitor.sqlite3").read_bytes().decode(errors="ignore"),
        )

    async def test_timeout_interrupts_and_closes_context(self):
        turn = FakeTurn(1, block=True)
        sdk = FakeSdk(turn)
        executor = self.executor(sdk)
        conversation = await self.create(executor)
        answer = await executor.generate(
            GenerateRequest(
                request_id=identifier(),
                conversation=conversation.name,
                input="synthetic",
                timeout_ms=10,
            ),
            self.home,
        )
        self.assertEqual(answer.state, "failed")
        self.assertTrue(turn.interrupted)
        self.assertTrue(sdk.closed)
        self.assertEqual((await executor.get(conversation.name)).state, "closed")

    async def test_context_expiry_cleans_up_without_a_followup_request(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        receipt = await self.create(executor, timeout_ms=20)
        await asyncio.wait_for(sdk.close_started.wait(), timeout=1)
        self.assertEqual((await executor.get(receipt.name)).state, "expired")
        self.assertFalse(pathlib.Path(sdk.config.cwd).exists())

    async def test_failed_cleanup_never_persists_a_closed_ack(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        receipt = await self.create(executor)
        with patch.object(
            sdk, "close", side_effect=RuntimeError("synthetic cleanup failure")
        ):
            with self.assertRaises(RuntimeError):
                await executor.close(receipt.name, identifier())
        self.assertEqual(executor.store.get(receipt.name).state, "open")
        self.assertTrue(pathlib.Path(sdk.config.cwd).exists())
        self.assertEqual(
            (await executor.close(receipt.name, identifier())).state, "closed"
        )

    async def test_restart_reports_lost_context_then_confirms_closed(self):
        executor = self.executor(FakeSdk())
        receipt = await self.create(executor)
        context = executor.contexts.pop(receipt.name)
        context.expiry.cancel()
        await executor._cleanup(context)
        restarted = self.executor(FakeSdk())
        self.assertEqual((await restarted.get(receipt.name)).state, "lost")
        self.assertEqual(
            (await restarted.close(receipt.name, identifier())).state, "closed"
        )

    async def test_schema_failure_and_local_tool_failures_have_no_output(self):
        for turn in (
            FakeTurn(1, output='{"ok":"wrong type"}'),
            FakeTurn(1, tools=({"type": "commandExecution"},), output='{"ok":true}'),
        ):
            with self.subTest(turn=turn):
                executor = self.executor(FakeSdk(turn))
                answer = await executor.generate(
                    GenerateRequest(
                        request_id=identifier(),
                        config=config(
                            output_schema_json=json.dumps(
                                {
                                    "type": "object",
                                    "properties": {"ok": {"type": "boolean"}},
                                    "required": ["ok"],
                                }
                            )
                        ),
                        input="synthetic",
                    ),
                    self.home,
                )
                self.assertEqual(answer.state, "failed")
                self.assertEqual(answer.output, "")
                self.assertTrue(answer.usage.available)

    async def test_create_is_idempotent_and_rejects_changed_config(self):
        executor = self.executor(FakeSdk())
        receipt = await self.create(executor)
        same = CreateConversationRequest(
            request_id=identifier(),
            conversation=dataclasses.replace(receipt, config=config()),
        )
        self.assertEqual((await executor.create(same, self.home)).name, receipt.name)
        with self.assertRaises(RpcError):
            await executor.create(
                dataclasses.replace(
                    same,
                    conversation=dataclasses.replace(
                        same.conversation, config=config(web_research=True)
                    ),
                ),
                self.home,
            )

    async def test_invalid_parameters_and_timeout_never_start_sdk(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        for request in (
            GenerateRequest(
                request_id=identifier(),
                config=config(),
                conversation="conversations/invalid",
                input="synthetic",
            ),
            GenerateRequest(
                request_id=identifier(),
                config=config(parameters=Parameters(temperature=0.5)),
                input="synthetic",
            ),
            GenerateRequest(
                request_id=identifier(),
                config=config(),
                input="synthetic",
                timeout_ms=840001,
            ),
        ):
            with self.assertRaises(RpcError):
                await executor.generate(request, self.home)
        self.assertEqual(sdk.started, 0)

    async def test_close_cancels_active_turn_before_ack(self):
        turn = FakeTurn(1, block=True)
        sdk = FakeSdk(turn)
        executor = self.executor(sdk)
        receipt = await self.create(executor)
        task = asyncio.create_task(
            executor.generate(
                GenerateRequest(
                    request_id=identifier(),
                    conversation=receipt.name,
                    input="synthetic",
                ),
                self.home,
            )
        )
        while not sdk.calls:
            await asyncio.sleep(0)
        closed = await executor.close(receipt.name, identifier())
        self.assertEqual(closed.state, "closed")
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(turn.interrupted)
        self.assertTrue(sdk.closed)

    async def test_http_uses_root_contract_for_json_and_private_sse(self):
        sdk = FakeSdk(FakeTurn(1), FakeTurn(1), FakeTurn(1))
        executor = self.executor(sdk)
        app = create_app(
            access_verifier=verifier(),
            monitor_db=self.home / "monitor.sqlite3",
            model_executor=executor,
        )
        headers = access_headers()
        with patch.dict(
            os.environ,
            {"CODEX_HOME": str(self.home)},
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                denied = await client.post(
                    "/api/model/v1/generations:generate", json={}
                )
                self.assertEqual(denied.status_code, 401)
                request = GenerateRequest(
                    request_id=identifier(), config=config(), input="synthetic"
                )
                response = await client.post(
                    "/api/model/v1/generations:generate",
                    json=to_wire(request),
                    headers=headers,
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["usage"]["input_tokens"], 101)
                streamed = await client.post(
                    "/api/model/v1/generations:generate",
                    json=to_wire(dataclasses.replace(request, request_id=identifier())),
                    headers={**headers, "accept": "text/event-stream"},
                )
                self.assertEqual(streamed.status_code, 200)
                self.assertIn("event: ready\ndata: {}\n\n", streamed.text)
                self.assertIn("event: result\ndata: ", streamed.text)
                self.assertIn('"state":"succeeded"', streamed.text)
                aliased = await client.post(
                    "/api/codex/v1/model/generations:generate",
                    json=to_wire(dataclasses.replace(request, request_id=identifier())),
                    headers=headers,
                )
                self.assertEqual(aliased.status_code, 200)
                self.assertEqual(aliased.json()["state"], "succeeded")
                self.assertEqual(
                    (await client.get("/healthz")).json()["inference_status"][
                        "request_count"
                    ],
                    3,
                )
                invalid = await client.post(
                    "/api/model/v1/generations:generate",
                    json=to_wire(dataclasses.replace(request, timeout_ms=840001)),
                    headers={**headers, "accept": "text/event-stream"},
                )
                self.assertEqual(invalid.status_code, 400)

    async def test_http_conversation_create_get_and_close_follow_generated_binding(
        self,
    ):
        executor = self.executor(FakeSdk())
        app = create_app(
            access_verifier=verifier(),
            monitor_db=self.home / "monitor.sqlite3",
            model_executor=executor,
        )
        headers = access_headers()
        context = Conversation(name=f"conversations/{identifier()}", config=config())
        with patch.dict(
            os.environ,
            {"CODEX_HOME": str(self.home)},
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                created = await client.post(
                    "/api/model/v1/conversations",
                    params={"request_id": identifier()},
                    json=to_wire(context),
                    headers=headers,
                )
                self.assertEqual(created.status_code, 200, created.text)
                read = await client.get(
                    "/api/model/v1/" + context.name, headers=headers
                )
                self.assertEqual(read.status_code, 200, read.text)
                self.assertEqual(read.json()["state"], "open")
                closed = await client.post(
                    "/api/model/v1/" + context.name + ":close",
                    json={"request_id": identifier()},
                    headers=headers,
                )
                self.assertEqual(closed.status_code, 200, closed.text)
                self.assertEqual(closed.json()["state"], "closed")

    async def test_private_sse_heartbeats_and_disconnect_cancel_execution(self):
        interrupted = asyncio.Event()

        async def operation():
            try:
                await asyncio.Event().wait()
            finally:
                interrupted.set()

        with patch("codex_gateway.model_api.HEARTBEAT_SECONDS", 0.001):
            stream = result_events(operation())
            self.assertIn("event: ready", await anext(stream))
            self.assertIn("event: heartbeat", await anext(stream))
            await stream.aclose()
        self.assertTrue(interrupted.is_set())

    async def test_model_api_preserves_newsletter_sized_inputs_and_outputs(self):
        sdk = FakeSdk(FakeTurn(1, output="synthetic " * 10000))
        executor = self.executor(sdk)
        app = create_app(
            access_verifier=verifier(),
            monitor_db=self.home / "monitor.sqlite3",
            model_executor=executor,
        )
        request = GenerateRequest(
            request_id=identifier(),
            config=config(),
            input="x" * 1048576,
        )
        with patch.dict(
            os.environ,
            {"CODEX_HOME": str(self.home)},
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    "/api/codex/v1/model/generations:generate",
                    json=to_wire(request),
                    headers=access_headers(),
                )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"], "succeeded")
        self.assertEqual(len(response.json()["output"]), 100000)


if __name__ == "__main__":
    unittest.main()
