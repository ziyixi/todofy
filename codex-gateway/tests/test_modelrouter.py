"""Actual two-turn, web evidence, usage deltas and cleanup using a fake SDK."""

import asyncio
import json
import pathlib
import tempfile
import unittest
import uuid
from unittest.mock import patch

from model_fixtures import FakeSdk, FakeTurn
from openai_codex.errors import CodexRpcError, InvalidParamsError, ServerBusyError
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    CreateConversationRequest,
    GenerateRequest,
    Instruction,
)
from ziyixi_proto.rpc_status import RpcError

from codex_gateway.modelrouter import ModelExecutor
from codex_gateway.runtime import MODEL


def context_name():
    return f"conversations/{uuid.uuid4()}"


class ModelRouterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="executor-test-")
        self.home = pathlib.Path(self.temp.name)
        self.executors = []

    async def asyncTearDown(self):
        for executor in self.executors:
            await executor.shutdown()
        self.temp.cleanup()

    def executor(self, sdk):
        executor = ModelExecutor(sdk=sdk)
        self.executors.append(executor)
        return executor

    async def create(self, executor, **options):
        request = CreateConversationRequest(name=context_name(), model=MODEL, **options)
        self.assertIsNone(await executor.create(request, self.home))
        return request.name

    async def test_two_turns_reuse_thread_and_report_per_call_totals(self):
        sdk = FakeSdk(FakeTurn(1), FakeTurn(2))
        executor = self.executor(sdk)
        name = await self.create(
            executor, instructions=(Instruction(text="Synthetic instructions"),)
        )
        directory = pathlib.Path(executor.contexts[name].directory.name)
        answers = [
            await executor.generate(
                GenerateRequest(conversation=name, input=text), self.home
            )
            for text in ("first synthetic turn", "second synthetic turn")
        ]
        self.assertEqual(sdk.started, 1)
        self.assertEqual(
            [call[0] for call in sdk.calls],
            ["first synthetic turn", "second synthetic turn"],
        )
        self.assertTrue(all("effort" not in call[1] for call in sdk.calls))
        self.assertEqual(sdk.thread_options["model"], MODEL)
        self.assertTrue(sdk.thread_options["ephemeral"])
        for answer in answers:
            self.assertIsNone(answer.error)
            self.assertEqual(answer.model, MODEL)
            self.assertTrue(answer.usage.available)
            self.assertEqual(
                (
                    answer.usage.input_tokens,
                    answer.usage.output_tokens,
                    answer.usage.cached_input_tokens,
                ),
                (101, 21, 50),
            )
            uuid.UUID(answer.name.split("/")[1])
        self.assertNotEqual(answers[0].name, answers[1].name)
        self.assertIsNone(await executor.close(name))
        self.assertTrue(sdk.closed)
        self.assertFalse(directory.exists())
        self.assertEqual(executor.contexts, {})
        self.assertIsNone(await executor.close(name))

    async def test_web_evidence_is_observed_per_turn_and_text_cannot_claim_it(self):
        url = "https://synthetic.example/article"
        sdk = FakeSdk(
            FakeTurn(
                1,
                tools=(
                    {
                        "type": "webSearch",
                        "action": {"type": "search", "query": "synthetic"},
                    },
                    {"type": "webSearch", "action": {"type": "openPage", "url": url}},
                ),
            ),
            FakeTurn(2, output="I searched and opened another URL"),
        )
        executor = self.executor(sdk)
        name = await self.create(executor, web_research=True, effort="medium")
        first = await executor.generate(
            GenerateRequest(conversation=name, input="research"), self.home
        )
        second = await executor.generate(
            GenerateRequest(conversation=name, input="correction"), self.home
        )
        self.assertTrue(first.observations.searched)
        self.assertEqual(first.observations.opened_urls, (url,))
        self.assertFalse(second.observations.searched)
        self.assertEqual(second.observations.opened_urls, ())
        self.assertEqual(sdk.calls[0][1]["effort"].value, "medium")
        self.assertIn('web_search="live"', sdk.config.config_overrides)
        self.assertIn("features.code_mode_host=true", sdk.config.config_overrides)
        self.assertIn("features.shell_tool=false", sdk.config.config_overrides)

    async def test_invalid_answer_keeps_context_for_correction_and_explicit_close(self):
        url = "https://synthetic.example/article"
        schema = '{"type":"object","required":["ok"]}'
        sdk = FakeSdk(
            FakeTurn(
                1,
                output="not JSON",
                tools=(
                    {"type": "webSearch", "action": {"type": "search"}},
                    {"type": "webSearch", "action": {"type": "openPage", "url": url}},
                ),
            ),
            FakeTurn(2, output='{"ok":true}'),
        )
        executor = self.executor(sdk)
        name = await self.create(executor, web_research=True, output_schema_json=schema)
        context = executor.contexts[name]
        directory = pathlib.Path(context.directory.name)
        deadline = context.deadline

        failed = await executor.generate(
            GenerateRequest(conversation=name, input="synthetic research"), self.home
        )
        self.assertEqual(
            (failed.error.code, failed.error.reason), (13, "MODEL_INVALID_ANSWER")
        )
        self.assertEqual(failed.output, "")
        self.assertTrue(failed.observations.searched)
        self.assertEqual(failed.observations.opened_urls, (url,))
        self.assertIs(executor.contexts[name], context)
        self.assertFalse(sdk.closed)

        corrected = await executor.generate(
            GenerateRequest(conversation=name, input="correct the JSON format"),
            self.home,
        )
        self.assertIsNone(corrected.error)
        self.assertEqual(json.loads(corrected.output), {"ok": True})
        self.assertFalse(corrected.observations.searched)
        self.assertEqual(corrected.observations.opened_urls, ())
        for answer in (failed, corrected):
            self.assertTrue(answer.usage.available)
            self.assertEqual(
                (answer.usage.input_tokens, answer.usage.output_tokens), (101, 21)
            )
        self.assertNotEqual(failed.name, corrected.name)
        self.assertEqual(sdk.started, 1)
        self.assertEqual(len(sdk.calls), 2)
        self.assertEqual(
            [call[1]["output_schema"] for call in sdk.calls],
            [json.loads(schema), json.loads(schema)],
        )
        self.assertEqual(context.deadline, deadline)
        self.assertIsNone(await executor.close(name))
        self.assertTrue(sdk.closed)
        self.assertFalse(directory.exists())
        self.assertNotIn(name, executor.contexts)

    async def test_invalid_answer_context_expires_without_another_turn(self):
        sdk = FakeSdk(FakeTurn(output="not JSON"))
        executor = self.executor(sdk)
        name = await self.create(
            executor, timeout_ms=100, output_schema_json='{"type":"object"}'
        )
        directory = pathlib.Path(executor.contexts[name].directory.name)
        failed = await executor.generate(
            GenerateRequest(conversation=name, input="synthetic"), self.home
        )
        self.assertEqual(failed.error.reason, "MODEL_INVALID_ANSWER")
        self.assertIn(name, executor.contexts)
        await asyncio.wait_for(sdk.close_started.wait(), 1)
        await asyncio.sleep(0)
        self.assertTrue(sdk.closed)
        self.assertFalse(directory.exists())
        self.assertNotIn(name, executor.contexts)
        with self.assertRaises(RpcError) as closed:
            await executor.generate(
                GenerateRequest(conversation=name, input="late correction"), self.home
            )
        self.assertEqual(closed.exception.reason, "CONVERSATION_CLOSED")
        self.assertEqual(len(sdk.calls), 1)

    async def test_other_context_failures_still_close_context(self):
        for turn, reason in (
            (FakeTurn(output="x" * 33), "MODEL_OUTPUT_LIMIT"),
            (
                FakeTurn(tools=({"type": "commandExecution"},)),
                "MODEL_UNSUPPORTED_TOOL",
            ),
            (FakeTurn(failure_info="unauthorized"), "MODEL_AUTH"),
            (
                FakeTurn(error=InvalidParamsError(-32602, "Synthetic rejection")),
                "MODEL_INVALID_REQUEST",
            ),
            (FakeTurn(error=ServerBusyError(-32000, "Synthetic busy")), "MODEL_BUSY"),
        ):
            with self.subTest(reason=reason):
                sdk = FakeSdk(turn)
                executor = self.executor(sdk)
                name = await self.create(executor)
                directory = pathlib.Path(executor.contexts[name].directory.name)
                with patch("codex_gateway.modelrouter.MAX_GENERATION_OUTPUT_BYTES", 32):
                    answer = await executor.generate(
                        GenerateRequest(conversation=name, input="synthetic"), self.home
                    )
                self.assertEqual(answer.error.reason, reason)
                self.assertEqual(answer.output, "")
                self.assertTrue(sdk.closed)
                self.assertFalse(directory.exists())
                self.assertNotIn(name, executor.contexts)

    async def test_unknown_snapshot_does_not_turn_into_zero_or_cumulative_usage(self):
        sdk = FakeSdk(FakeTurn(1, usage=False), FakeTurn(2), FakeTurn(3))
        executor = self.executor(sdk)
        name = await self.create(executor)
        answers = [
            await executor.generate(
                GenerateRequest(conversation=name, input="synthetic"), self.home
            )
            for _ in range(3)
        ]
        self.assertEqual(
            [answer.usage.available for answer in answers], [False, False, True]
        )
        self.assertEqual(answers[2].usage.input_tokens, 101)
        self.assertEqual(answers[2].usage.output_tokens, 21)

    async def test_decreasing_or_malformed_usage_remains_unknown(self):
        for counters in (
            {"inputTokens": -1},
            {"inputTokens": True},
            {
                "inputTokens": 1,
                "outputTokens": 1,
                "cachedInputTokens": 1,
                "cacheWriteInputTokens": 0,
            },
        ):
            with self.subTest(counters=counters):
                sdk = FakeSdk(FakeTurn(1), FakeTurn(2, counters=counters))
                executor = self.executor(sdk)
                name = await self.create(executor)
                await executor.generate(
                    GenerateRequest(conversation=name, input="first"), self.home
                )
                answer = await executor.generate(
                    GenerateRequest(conversation=name, input="second"), self.home
                )
                self.assertFalse(answer.usage.available)
                await executor.close(name)

    async def test_standalone_schema_and_explicit_effort_with_primary_only_policy(self):
        sdk = FakeSdk(FakeTurn(output='{"ok":true}'))
        executor = self.executor(sdk)
        answer = await executor.generate(
            GenerateRequest(
                model=MODEL,
                input="Synthetic",
                effort="high",
                allow_fallback=True,
                instructions=(
                    Instruction(text="First"),
                    Instruction(text="Second", cache=True),
                ),
                output_schema_json='{"type":"object","required":["ok"]}',
            ),
            self.home,
        )
        self.assertIsNone(answer.error)
        self.assertEqual(json.loads(answer.output), {"ok": True})
        self.assertEqual(
            sdk.thread_options["developer_instructions"], "First\n\nSecond"
        )
        self.assertEqual(sdk.calls[0][1]["effort"].value, "high")
        self.assertTrue(sdk.closed)
        self.assertFalse(pathlib.Path(sdk.thread_options["cwd"]).exists())

    async def test_invalid_options_fail_before_opening_the_sdk(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        requests = (
            GenerateRequest(model="models/sol-6-1", input="x"),
            GenerateRequest(model="gpt-6-astra", input="x"),
            GenerateRequest(model=MODEL, input="x", effort="invalid"),
            GenerateRequest(model=MODEL, input="x", max_output_tokens=100),
            GenerateRequest(model=MODEL, input="x", timeout_ms=840001),
            GenerateRequest(model=MODEL, input="x", timeout_ms=-1),
            GenerateRequest(
                model=MODEL,
                input="x",
                output_schema_json='{"$ref":"https://synthetic.invalid/schema"}',
            ),
            GenerateRequest(
                model=MODEL, input="x", instructions=(Instruction(text=" "),)
            ),
            GenerateRequest(model=MODEL, input=""),
        )
        for request in requests:
            with self.subTest(request=request):
                with self.assertRaises(RpcError):
                    await executor.generate(request, self.home)
        self.assertEqual(sdk.started, 0)

    async def test_bad_output_tool_and_provider_errors_are_safe_and_cleaned_up(self):
        cases = [
            (
                FakeTurn(output="not json"),
                '{"type":"object"}',
                13,
                "MODEL_INVALID_ANSWER",
            ),
            (
                FakeTurn(output="{}"),
                '{"type":"object","required":["ok"]}',
                13,
                "MODEL_INVALID_ANSWER",
            ),
            (
                FakeTurn(output='{"ok":NaN}'),
                '{"type":"object"}',
                13,
                "MODEL_INVALID_ANSWER",
            ),
            (
                FakeTurn(tools=({"type": "commandExecution"},)),
                "",
                13,
                "MODEL_UNSUPPORTED_TOOL",
            ),
            (
                FakeTurn(
                    error=CodexRpcError(
                        -32000,
                        "Synthetic private provider text",
                        {"codexErrorInfo": "unauthorized"},
                    )
                ),
                "",
                16,
                "MODEL_AUTH",
            ),
            (
                FakeTurn(
                    error=CodexRpcError(
                        -32000,
                        "Synthetic private provider text",
                        {"codexErrorInfo": "usageLimitExceeded"},
                    )
                ),
                "",
                8,
                "MODEL_QUOTA",
            ),
            (
                FakeTurn(
                    error=ServerBusyError(-32000, "Synthetic private provider text")
                ),
                "",
                14,
                "MODEL_BUSY",
            ),
            (
                FakeTurn(error=ValueError("Synthetic private SDK value error")),
                "",
                14,
                "MODEL_UNAVAILABLE",
            ),
        ]
        for turn, schema, code, reason in cases:
            with self.subTest(reason=reason):
                sdk = FakeSdk(turn)
                answer = await self.executor(sdk).generate(
                    GenerateRequest(model=MODEL, input="x", output_schema_json=schema),
                    self.home,
                )
                self.assertEqual(answer.error.code, code)
                self.assertEqual(answer.error.reason, reason)
                self.assertEqual(answer.output, "")
                self.assertNotIn("private provider", answer.error.message)
                self.assertTrue(sdk.closed)
                self.assertFalse(pathlib.Path(sdk.thread_options["cwd"]).exists())

    async def test_failed_turn_keeps_known_sdk_category_and_reported_usage(self):
        for info, code, reason in (
            ("serverOverloaded", 14, "MODEL_BUSY"),
            ("rateLimitExceeded", 8, "MODEL_RATE_LIMIT"),
            ("unauthorized", 16, "MODEL_AUTH"),
            ("badRequest", 3, "MODEL_INVALID_REQUEST"),
            ({"httpConnectionFailed": {"httpStatusCode": 401}}, 16, "MODEL_AUTH"),
            ("other", 14, "MODEL_UNAVAILABLE"),
        ):
            with self.subTest(info=info):
                sdk = FakeSdk(FakeTurn(failure_info=info))
                answer = await self.executor(sdk).generate(
                    GenerateRequest(model=MODEL, input="synthetic"), self.home
                )
                self.assertEqual(
                    (answer.error.code, answer.error.reason), (code, reason)
                )
                self.assertTrue(answer.usage.available)
                self.assertEqual(answer.usage.input_tokens, 101)
                self.assertEqual(answer.output, "")
                self.assertNotIn("private", answer.error.message)
                self.assertNotIn("synthetic.invalid", answer.error.message)
                self.assertTrue(sdk.closed)

    async def test_sdk_rejecting_schema_is_an_invalid_request_not_invalid_output(self):
        sdk = FakeSdk(
            FakeTurn(
                error=InvalidParamsError(-32602, "Private synthetic schema rejection")
            )
        )
        answer = await self.executor(sdk).generate(
            GenerateRequest(
                model=MODEL,
                input="synthetic",
                output_schema_json='{"type":"array","items":{"type":"string"}}',
            ),
            self.home,
        )
        self.assertEqual(
            (answer.error.code, answer.error.reason), (3, "MODEL_INVALID_REQUEST")
        )
        self.assertFalse(answer.usage.available)
        self.assertEqual(answer.output, "")
        self.assertTrue(sdk.closed)

    async def test_busy_during_context_setup_preserves_reason_and_cleans_up(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        request = CreateConversationRequest(name=context_name(), model=MODEL)
        with patch.object(
            sdk,
            "__aenter__",
            side_effect=ServerBusyError(-32000, "Synthetic private details"),
        ):
            with self.assertRaises(RpcError) as busy:
                await executor.create(request, self.home)
        self.assertEqual(
            (busy.exception.code, busy.exception.reason), ("UNAVAILABLE", "MODEL_BUSY")
        )
        self.assertNotIn("private", str(busy.exception))
        self.assertTrue(sdk.closed)
        self.assertEqual(executor.contexts, {})

    async def test_invalid_request_during_context_setup_preserves_http400(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        request = CreateConversationRequest(name=context_name(), model=MODEL)
        with patch.object(
            sdk,
            "__aenter__",
            side_effect=InvalidParamsError(-32602, "Private synthetic rejection"),
        ):
            with self.assertRaises(RpcError) as invalid:
                await executor.create(request, self.home)
        self.assertEqual(invalid.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(invalid.exception.http_status, 400)
        self.assertEqual(invalid.exception.reason, "MODEL_INVALID_REQUEST")
        self.assertNotIn("Private", str(invalid.exception))
        self.assertTrue(sdk.closed)
        self.assertEqual(executor.contexts, {})

    async def test_context_rejects_option_overrides_and_concurrent_turns(self):
        turn = FakeTurn(block=True)
        executor = self.executor(FakeSdk(turn))
        name = await self.create(executor)
        with self.assertRaises(RpcError):
            await executor.generate(
                GenerateRequest(conversation=name, model=MODEL, input="x"), self.home
            )
        task = asyncio.create_task(
            executor.generate(
                GenerateRequest(conversation=name, input="first"), self.home
            )
        )
        await turn.started.wait()
        with self.assertRaises(RpcError) as busy:
            await executor.generate(
                GenerateRequest(conversation=name, input="second"), self.home
            )
        self.assertEqual(busy.exception.reason, "CONVERSATION_BUSY")
        await executor.close(name)
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(turn.interrupted)

    async def test_close_waits_for_cleanup_and_cancels_an_active_turn(self):
        turn = FakeTurn(block=True)
        sdk = FakeSdk(turn)
        executor = self.executor(sdk)
        name = await self.create(executor)
        path = pathlib.Path(executor.contexts[name].directory.name)
        operation = asyncio.create_task(
            executor.generate(GenerateRequest(conversation=name, input="x"), self.home)
        )
        await turn.started.wait()
        sdk.allow_close.clear()
        closing = asyncio.create_task(executor.close(name))
        await sdk.close_started.wait()
        self.assertFalse(closing.done())
        self.assertTrue(path.exists())
        sdk.allow_close.set()
        self.assertIsNone(await closing)
        with self.assertRaises(asyncio.CancelledError):
            await operation
        self.assertFalse(path.exists())

    async def test_close_waits_for_a_pending_create_to_be_cancelled_and_cleaned(self):
        sdk = FakeSdk()
        sdk.allow_open.clear()
        sdk.allow_close.clear()
        executor = self.executor(sdk)
        request = CreateConversationRequest(name=context_name(), model=MODEL)
        opening = asyncio.create_task(executor.create(request, self.home))
        await sdk.open_started.wait()
        closing = asyncio.create_task(executor.close(request.name))
        await sdk.close_started.wait()
        self.assertFalse(closing.done())
        sdk.allow_close.set()
        self.assertIsNone(await closing)
        with self.assertRaises(asyncio.CancelledError):
            await opening
        self.assertEqual(executor.contexts, {})

    async def test_timeout_expiry_and_external_cancellation_cleanup(self):
        for context in (False, True):
            with self.subTest(context=context):
                turn = FakeTurn(block=True)
                sdk = FakeSdk(turn)
                executor = self.executor(sdk)
                name = await self.create(executor) if context else ""
                request = GenerateRequest(
                    model="" if context else MODEL,
                    conversation=name,
                    input="x",
                    timeout_ms=10,
                )
                answer = await executor.generate(request, self.home)
                self.assertEqual(answer.error.reason, "MODEL_TIMEOUT")
                self.assertTrue(turn.interrupted)
                self.assertTrue(sdk.closed)
        sdk = FakeSdk()
        executor = self.executor(sdk)
        name = await self.create(executor, timeout_ms=10)
        await asyncio.wait_for(sdk.close_started.wait(), 1)
        await asyncio.sleep(0)
        self.assertNotIn(name, executor.contexts)
        turn = FakeTurn(block=True)
        sdk = FakeSdk(turn)
        executor = self.executor(sdk)
        operation = asyncio.create_task(
            executor.generate(GenerateRequest(model=MODEL, input="x"), self.home)
        )
        await turn.started.wait()
        operation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await operation
        self.assertTrue(sdk.closed)
        self.assertTrue(turn.interrupted)

    async def test_account_and_skills_checks_reject_before_starting_a_turn(self):
        for sdk in (FakeSdk(account_type="apikey"), FakeSdk(enabled_skill=True)):
            answer = await self.executor(sdk).generate(
                GenerateRequest(model=MODEL, input="x"), self.home
            )
            self.assertIsNotNone(answer.error)
            self.assertEqual(sdk.started, 0)
            self.assertTrue(sdk.closed)

    async def test_repeated_create_and_unknown_close_need_no_persistent_ledger(self):
        executor = self.executor(FakeSdk())
        request = CreateConversationRequest(name=context_name(), model=MODEL)
        await executor.create(request, self.home)
        with self.assertRaises(RpcError):
            await executor.create(request, self.home)
        await executor.close(request.name)
        self.assertIsNone(await self.executor(FakeSdk()).close(request.name))
        self.assertEqual(list(self.home.glob("*.sqlite3")), [])

    async def test_close_failure_never_acknowledges_or_discards_an_open_context(self):
        sdk = FakeSdk()
        executor = self.executor(sdk)
        name = await self.create(executor)
        workspace = pathlib.Path(executor.contexts[name].directory.name)
        sdk.close_raises = True
        try:
            with self.assertRaises(RpcError) as failed:
                await executor.close(name)
        finally:
            sdk.close_raises = False
        self.assertEqual(failed.exception.reason, "MODEL_CLEANUP_PENDING")
        self.assertNotIn("private", str(failed.exception))
        self.assertIn(name, executor.contexts)
        self.assertTrue(workspace.exists())
        self.assertIsNone(await executor.close(name))
        self.assertFalse(workspace.exists())
