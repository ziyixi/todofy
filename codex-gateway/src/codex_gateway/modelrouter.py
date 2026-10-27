"""Finite Codex turns and one ephemeral SDK thread per Newsletter context."""

import asyncio
import contextlib
import dataclasses
import json
import os
import pathlib
import signal
import tempfile
import time
import uuid
from typing import Any

import jsonschema
from openai_codex.types import ReasoningEffort
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    CreateConversationRequest,
    GenerateRequest,
    Generation,
    ListModelsResponse,
    Model,
    ModelError,
)
from ziyixi_proto.rpc_status import RpcError

from codex_gateway.model_events import TurnEvents, UnsupportedToolError
from codex_gateway.runtime import (
    MODEL,
    _assert_no_skills,
    _interrupt,
    execution_error,
    runtime_config,
)

DEFAULT_TIMEOUT_MS = 110_000
MAX_TIMEOUT_MS = 840_000
MAX_GENERATION_OUTPUT_BYTES = 2 * 1024 * 1024
EFFORTS = ("low", "medium", "high", "xhigh", "max")


def invalid(message: str = "Invalid model request") -> RpcError:
    return RpcError("INVALID_ARGUMENT", "INVALID_MODEL_REQUEST", message)


def validate_name(name: str) -> None:
    try:
        prefix, value = name.split("/", 1)
        if prefix != "conversations" or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise invalid("A conversations/{UUID} name is required") from None


def timeout_ms(value: int, default: int = DEFAULT_TIMEOUT_MS) -> int:
    if value < 0 or value > MAX_TIMEOUT_MS:
        raise invalid("Timeout must be at most 840000 milliseconds")
    return value or default


def validate_options(request: GenerateRequest | CreateConversationRequest) -> None:
    if request.model != MODEL:
        raise invalid("Only gpt-6.1-sol is configured on this executor")
    if request.effort and request.effort not in EFFORTS:
        raise invalid("Unsupported model effort")
    if isinstance(request, GenerateRequest) and request.max_output_tokens:
        raise invalid("This model does not support an output token cap")
    if any(not instruction.text.strip() for instruction in request.instructions):
        raise invalid("Instruction text must not be empty")
    if request.output_schema_json:
        try:
            schema = json.loads(request.output_schema_json)
            json.dumps(schema, allow_nan=False)
            jsonschema.Draft202012Validator.check_schema(schema)
            pending = [schema]
            while pending:
                value = pending.pop()
                if isinstance(value, dict):
                    for key in ("$ref", "$dynamicRef"):
                        if key in value and (
                            not isinstance(value[key], str)
                            or not value[key].startswith("#")
                        ):
                            raise ValueError
                    pending.extend(value.values())
                elif isinstance(value, list):
                    pending.extend(value)
        except (ValueError, TypeError, jsonschema.SchemaError, RecursionError):
            raise invalid("Invalid JSON Schema") from None


def process_of(client: Any) -> Any:
    transport = getattr(client, "_client", None)
    return getattr(getattr(transport, "_sync", None), "_proc", None)


@dataclasses.dataclass
class ExecutionContext:
    options: CreateConversationRequest
    deadline: float
    directory: Any = None
    client: Any = None
    thread: Any = None
    turn: Any = None
    task: asyncio.Task | None = None
    expiry: asyncio.Task | None = None
    totals: dict[str, int] | None = None
    turns: int = 0
    closing: bool = False
    closed: bool = False
    cleanup_lock: asyncio.Lock = dataclasses.field(default_factory=asyncio.Lock)


class ModelExecutor:
    def __init__(self, *, sdk: Any = None):
        self.sdk = sdk
        self.contexts: dict[str, ExecutionContext] = {}

    @staticmethod
    def validate_create(request: CreateConversationRequest) -> None:
        validate_name(request.name)
        validate_options(request)
        timeout_ms(request.timeout_ms, MAX_TIMEOUT_MS)

    @staticmethod
    def validate_generate(request: GenerateRequest) -> None:
        if not request.input:
            raise invalid("Input text is required")
        timeout_ms(request.timeout_ms)
        if request.conversation:
            validate_name(request.conversation)
            if any(
                (
                    request.model,
                    request.instructions,
                    request.effort,
                    request.max_output_tokens,
                    request.output_schema_json,
                    request.allow_fallback,
                )
            ):
                raise invalid("A context turn cannot replace its model or options")
        else:
            validate_options(request)

    @staticmethod
    def catalog() -> ListModelsResponse:
        return ListModelsResponse(
            models=(
                Model(
                    id=MODEL,
                    display_name="Sol 6.1",
                    provider="openai",
                    kind="text",
                    configured=True,
                    efforts=EFFORTS,
                ),
            )
        )

    def effort_for(self, request: GenerateRequest) -> str:
        context = self.contexts.get(request.conversation)
        return context.options.effort if context else request.effort

    async def _open(self, context: ExecutionContext, home: pathlib.Path) -> None:
        sdk = self.sdk
        if sdk is None:
            import openai_codex as sdk
        context.directory = tempfile.TemporaryDirectory(prefix="model-router-")
        workspace = pathlib.Path(context.directory.name)
        context.client = sdk.AsyncCodex(
            runtime_config(
                sdk,
                home,
                workspace,
                web_research=context.options.web_research,
            )
        )
        await context.client.__aenter__()
        account = await context.client.account(refresh_token=False)
        if getattr(getattr(account.account, "root", None), "type", None) != "chatgpt":
            raise RpcError(
                "UNAUTHENTICATED", "MODEL_AUTH", "Subscription account required"
            )
        await _assert_no_skills(context.client, workspace)
        context.thread = await context.client.thread_start(
            cwd=str(workspace),
            model=MODEL,
            model_provider="openai",
            sandbox=sdk.Sandbox.read_only,
            approval_mode=sdk.ApprovalMode.deny_all,
            ephemeral=True,
            developer_instructions="\n\n".join(
                item.text for item in context.options.instructions
            )
            or None,
        )

    async def create(
        self, request: CreateConversationRequest, home: pathlib.Path
    ) -> None:
        self.validate_create(request)
        if request.name in self.contexts:
            raise RpcError(
                "ALREADY_EXISTS", "CONVERSATION_EXISTS", "Context already exists"
            )
        budget = timeout_ms(request.timeout_ms, MAX_TIMEOUT_MS)
        context = ExecutionContext(
            options=request,
            deadline=time.monotonic() + budget / 1000,
            task=asyncio.current_task(),
        )
        self.contexts[request.name] = context
        try:
            async with asyncio.timeout(min(DEFAULT_TIMEOUT_MS, budget) / 1000):
                await self._open(context, home)
            context.task = None
            context.expiry = asyncio.create_task(self._expire(context))
        except asyncio.CancelledError:
            if not context.closing:
                await self._close(context)
            raise
        except Exception as error:
            if not context.closing:
                await self._close(context)
            if isinstance(error, TimeoutError):
                raise RpcError(
                    "DEADLINE_EXCEEDED", "MODEL_TIMEOUT", "Model setup timed out"
                ) from None
            failure = execution_error(error)
            status = {
                3: "INVALID_ARGUMENT",
                8: "RESOURCE_EXHAUSTED",
                16: "UNAUTHENTICATED",
            }.get(failure.code, "UNAVAILABLE")
            raise RpcError(status, failure.reason, failure.message) from None

    async def _expire(self, context: ExecutionContext) -> None:
        await asyncio.sleep(max(0, context.deadline - time.monotonic()))
        await self._close(context)

    async def close(self, name: str) -> None:
        validate_name(name)
        context = self.contexts.get(name)
        if context:
            try:
                await self._close(context)
            except Exception:
                raise RpcError(
                    "UNAVAILABLE",
                    "MODEL_CLEANUP_PENDING",
                    "Execution cleanup is not yet confirmed",
                ) from None

    async def _cleanup(self, context: ExecutionContext) -> None:
        process = process_of(context.client)
        if context.turn is not None:
            await _interrupt(context.turn)
        if context.client is not None:
            try:
                await asyncio.wait_for(context.client.close(), timeout=5)
            except Exception:
                if process is None:
                    raise RuntimeError("SDK cleanup failed") from None
        if process is not None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await asyncio.to_thread(process.wait, timeout=5)
        if context.directory is not None:
            context.directory.cleanup()

    async def _close(self, context: ExecutionContext) -> None:
        async with context.cleanup_lock:
            if context.closed:
                return
            context.closing = True
            current = asyncio.current_task()
            if context.task and context.task is not current:
                context.task.cancel()
                await asyncio.gather(context.task, return_exceptions=True)
            await self._cleanup(context)
            context.closed = True
            self.contexts.pop(context.options.name, None)
            if context.expiry and context.expiry is not current:
                context.expiry.cancel()

    async def shutdown(self) -> None:
        for context in tuple(self.contexts.values()):
            await self._close(context)

    async def generate(
        self, request: GenerateRequest, home: pathlib.Path
    ) -> Generation:
        self.validate_generate(request)
        budget = timeout_ms(request.timeout_ms)
        standalone = not request.conversation
        if standalone:
            context = ExecutionContext(
                options=CreateConversationRequest(
                    model=request.model,
                    instructions=request.instructions,
                    effort=request.effort,
                    output_schema_json=request.output_schema_json,
                ),
                deadline=time.monotonic() + budget / 1000,
            )
        else:
            context = self.contexts.get(request.conversation)
            if not context or context.closing:
                raise RpcError(
                    "FAILED_PRECONDITION", "CONVERSATION_CLOSED", "Context is closed"
                )
            if context.deadline <= time.monotonic():
                await self._close(context)
                raise RpcError(
                    "FAILED_PRECONDITION", "CONVERSATION_CLOSED", "Context is closed"
                )
            if context.task is not None:
                raise RpcError(
                    "ABORTED", "CONVERSATION_BUSY", "Context has an active operation"
                )
        return await self._generate(request, home, context, budget, standalone)

    async def _generate(self, request, home, context, budget, standalone) -> Generation:
        context.task = asyncio.current_task()
        options = context.options
        events = TurnEvents(context.totals, context.turns == 0, options.web_research)
        error = None
        cancelled = False
        try:
            async with asyncio.timeout(
                min(budget / 1000, max(0, context.deadline - time.monotonic()))
            ):
                if standalone:
                    await self._open(context, home)
                turn_options = {}
                if options.effort:
                    turn_options["effort"] = ReasoningEffort(options.effort)
                if options.output_schema_json:
                    turn_options["output_schema"] = json.loads(
                        options.output_schema_json
                    )
                context.turn = await context.thread.turn(request.input, **turn_options)
                context.turns += 1
                await events.collect(context.turn)
                if len(events.output.encode()) > MAX_GENERATION_OUTPUT_BYTES:
                    error = ModelError(
                        code=13,
                        reason="MODEL_OUTPUT_LIMIT",
                        message="Model output exceeded its size limit",
                    )
                elif options.output_schema_json:
                    try:
                        decoded = json.loads(events.output)
                        json.dumps(decoded, allow_nan=False)
                        jsonschema.Draft202012Validator(
                            json.loads(options.output_schema_json)
                        ).validate(decoded)
                    except (ValueError, TypeError, jsonschema.ValidationError):
                        error = ModelError(
                            code=13,
                            reason="MODEL_INVALID_ANSWER",
                            message="Model output did not match the requested JSON schema",
                        )
        except asyncio.CancelledError:
            cancelled = True
            error = ModelError(
                code=1, message="Model execution cancelled", reason="MODEL_CANCELLED"
            )
            if context.turn is not None:
                await _interrupt(context.turn)
        except TimeoutError:
            error = ModelError(
                code=4, message="Model execution timed out", reason="MODEL_TIMEOUT"
            )
            if context.turn is not None:
                await _interrupt(context.turn)
        except UnsupportedToolError:
            error = ModelError(
                code=13,
                reason="MODEL_UNSUPPORTED_TOOL",
                message="Model returned an unsupported tool event",
            )
        except Exception as exc:
            error = execution_error(exc)
        finally:
            context.totals = None if events.usage_invalid else events.latest
            if standalone:
                await self._cleanup(context)
            context.turn = None
            context.task = None
        if not standalone and error and not context.closing:
            await self._close(context)
        if cancelled:
            raise asyncio.CancelledError
        return Generation(
            name=f"requests/{uuid.uuid4()}",
            model=MODEL,
            output=events.output if error is None else "",
            usage=events.usage(),
            observations=events.observations(),
            error=error,
        )
