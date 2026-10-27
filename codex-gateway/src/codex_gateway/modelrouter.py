"""Bounded model turns and ephemeral SDK conversations; no replay or saved jobs."""

import asyncio
import contextlib
import dataclasses
import hashlib
import json
import os
import pathlib
import re
import signal
import time
import uuid
from datetime import UTC, datetime, timedelta
from importlib import metadata
from typing import Any

import jsonschema
from openai_codex.types import ReasoningEffort
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    Conversation,
    CreateConversationRequest,
    GenerateRequest,
    Generation,
    GenerationConfig,
    ListModelsResponse,
    Model,
    ModelError,
    Parameters,
)
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import to_wire

from codex_gateway.conversation_store import ConversationStore
from codex_gateway.model_events import TurnEvents
from codex_gateway.monitoring import timestamp
from codex_gateway.runtime import (
    _assert_no_skills,
    _interrupt,
    _login_home,
    failure_code,
    runtime_config,
)

DEFAULT_TIMEOUT_MS = 110_000
MAX_TIMEOUT_MS = 840_000
MAX_GENERATION_OUTPUT_BYTES = 2 * 1024 * 1024
MODEL_MAP = {
    "models/sol-6-1": "gpt-6.1-sol",
    "models/astra-6": "gpt-6-astra",
    "models/sol-6": "gpt-6-sol",
    "models/luna-6": "gpt-6-luna",
    "models/sol-5-6": "gpt-5.6-sol",
    "models/terra-5-6": "gpt-5.6-terra",
    "models/luna-5-6": "gpt-5.6-luna",
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
RESOURCE_NAME = re.compile(r"conversations/[a-zA-Z0-9_-]{1,128}")


def invalid(message: str = "Invalid model request") -> RpcError:
    return RpcError("INVALID_ARGUMENT", "INVALID_MODEL_REQUEST", message)


def validate_request_id(value: str) -> None:
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError):
        raise invalid("A UUID request_id is required") from None


def timeout_ms(value: int, default: int = DEFAULT_TIMEOUT_MS) -> int:
    if value < 0 or value > MAX_TIMEOUT_MS:
        raise invalid("Timeout must be at most 840000 milliseconds")
    return value or default


def validate_config(config: GenerationConfig) -> None:
    if config.model not in MODEL_MAP:
        raise invalid("Model is not configured on this executor")
    params = config.parameters or Parameters()
    if params.effort and params.effort not in EFFORTS:
        raise invalid("Unsupported model effort")
    if params.temperature is not None or params.max_output_tokens is not None:
        raise invalid("This model does not support the supplied parameter")
    if any(not item.text.strip() for item in config.instructions):
        raise invalid("Instruction text must not be empty")
    if config.output_schema_json:
        try:
            schema = json.loads(config.output_schema_json)
            json.dumps(schema, allow_nan=False)
            jsonschema.Draft202012Validator.check_schema(schema)
            pending = [schema]
            while pending:
                value = pending.pop()
                if isinstance(value, dict):
                    for key in ("$ref", "$dynamicRef"):
                        if key in value and not value[key].startswith("#"):
                            raise ValueError(
                                "External schema references are unsupported"
                            )
                    pending.extend(value.values())
                elif isinstance(value, list):
                    pending.extend(value)
        except (ValueError, jsonschema.SchemaError, RecursionError):
            raise invalid("Invalid JSON Schema") from None


def public_config(config: GenerationConfig) -> GenerationConfig:
    return GenerationConfig(
        model=config.model,
        parameters=config.parameters,
        web_research=config.web_research,
    )


def fingerprint(config: GenerationConfig) -> str:
    value = json.dumps(to_wire(config), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode()).hexdigest()


def process_of(client: Any) -> Any:
    transport = getattr(client, "_client", None)
    return getattr(getattr(transport, "_sync", None), "_proc", None)


@dataclasses.dataclass
class ExecutionContext:
    receipt: Conversation
    config: GenerationConfig
    config_hash: str
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
    lock: asyncio.Lock = dataclasses.field(default_factory=asyncio.Lock)
    cleanup_lock: asyncio.Lock = dataclasses.field(default_factory=asyncio.Lock)


class ModelExecutor:
    def __init__(self, database: pathlib.Path, *, sdk: Any = None):
        self.store = ConversationStore(database)
        self.sdk = sdk
        self.contexts: dict[str, ExecutionContext] = {}
        self.creating = asyncio.Lock()

    @staticmethod
    def validate_create(request: CreateConversationRequest) -> None:
        validate_request_id(request.request_id)
        if request.conversation is None or request.conversation.config is None:
            raise invalid("Conversation configuration is required")
        validate_config(request.conversation.config)
        timeout_ms(request.conversation.timeout_ms, MAX_TIMEOUT_MS)
        if request.conversation.name and not RESOURCE_NAME.fullmatch(
            request.conversation.name
        ):
            raise invalid("Invalid conversation name")

    @staticmethod
    def validate_generate(request: GenerateRequest) -> None:
        validate_request_id(request.request_id)
        if (request.config is not None) == bool(request.conversation):
            raise invalid("Supply exactly one config or conversation")
        if not request.input:
            raise invalid("Input text is required")
        timeout_ms(request.timeout_ms)
        if request.config is not None:
            validate_config(request.config)
        elif not RESOURCE_NAME.fullmatch(request.conversation):
            raise invalid("Invalid conversation name")

    def catalog(self) -> ListModelsResponse:
        return ListModelsResponse(
            models=tuple(
                Model(
                    name=name,
                    display_name=model,
                    provider="openai",
                    upstream_model=model,
                    configured=True,
                    generation=True,
                    conversations=True,
                    web_research=True,
                    efforts=EFFORTS,
                )
                for name, model in MODEL_MAP.items()
            )
        )

    async def _open(self, context: ExecutionContext, home: pathlib.Path) -> None:
        import tempfile

        sdk = self.sdk
        if sdk is None:
            import openai_codex as sdk

            if metadata.version("openai-codex") != metadata.version(
                "openai-codex-cli-bin"
            ):
                raise RuntimeError("configuration")
        _login_home(home)
        context.directory = tempfile.TemporaryDirectory(prefix="model-router-")
        workspace = pathlib.Path(context.directory.name)
        context.client = sdk.AsyncCodex(
            runtime_config(
                sdk, home, workspace, web_research=context.config.web_research
            )
        )
        await context.client.__aenter__()
        account = await context.client.account(refresh_token=False)
        if getattr(getattr(account.account, "root", None), "type", None) != "chatgpt":
            raise RuntimeError("authentication")
        await _assert_no_skills(context.client, workspace)
        context.thread = await context.client.thread_start(
            cwd=str(workspace),
            model=MODEL_MAP[context.config.model],
            model_provider="openai",
            sandbox=sdk.Sandbox.read_only,
            approval_mode=sdk.ApprovalMode.deny_all,
            ephemeral=True,
            developer_instructions="\n\n".join(
                item.text for item in context.config.instructions
            )
            or None,
        )

    async def create(
        self, request: CreateConversationRequest, home: pathlib.Path
    ) -> Conversation:
        self.validate_create(request)
        config = request.conversation.config
        budget = timeout_ms(request.conversation.timeout_ms, MAX_TIMEOUT_MS)
        name = request.conversation.name or f"conversations/{uuid.uuid4()}"
        if not RESOURCE_NAME.fullmatch(name):
            raise invalid("Invalid conversation name")
        async with self.creating:
            existing = self.contexts.get(name)
            if existing:
                if existing.config_hash != fingerprint(config):
                    raise RpcError(
                        "ALREADY_EXISTS", "CONVERSATION_EXISTS", "Conversation exists"
                    )
                return existing.receipt
            previous = self.store.get(name)
            if previous:
                if self.store.config_hash(name) == fingerprint(config):
                    return previous
                raise RpcError(
                    "ALREADY_EXISTS", "CONVERSATION_EXISTS", "Conversation exists"
                )
            receipt = Conversation(
                name=name,
                config=public_config(config),
                timeout_ms=budget,
                state="open",
                expire_time=timestamp(
                    datetime.now(UTC) + timedelta(milliseconds=budget)
                ),
            )
            context = ExecutionContext(
                receipt=receipt,
                config=config,
                config_hash=fingerprint(config),
                deadline=time.monotonic() + budget / 1000,
            )
            try:
                async with asyncio.timeout(min(DEFAULT_TIMEOUT_MS, budget) / 1000):
                    await self._open(context, home)
                self.store.put(receipt, context.directory.name, context.config_hash)
                self.contexts[name] = context
                context.expiry = asyncio.create_task(self._expire(context))
                return receipt
            except asyncio.CancelledError:
                await self._cleanup(context)
                raise
            except Exception as exc:
                await self._cleanup(context)
                if isinstance(exc, TimeoutError):
                    raise RpcError(
                        "DEADLINE_EXCEEDED", "MODEL_TIMEOUT", "Model setup timed out"
                    ) from None
                code = failure_code(exc)
                status = "UNAUTHENTICATED" if code == "codex_auth" else "UNAVAILABLE"
                raise RpcError(
                    status, "MODEL_UNAVAILABLE", "Model setup unavailable"
                ) from None

    async def _expire(self, context: ExecutionContext) -> None:
        await asyncio.sleep(max(0, context.deadline - time.monotonic()))
        await self._close(context, "expired")

    async def get(self, name: str) -> Conversation:
        if not RESOURCE_NAME.fullmatch(name):
            raise invalid("Invalid conversation name")
        context = self.contexts.get(name)
        if context:
            if context.deadline <= time.monotonic():
                await self._close(context, "expired")
            else:
                return context.receipt
        receipt = self.store.get(name)
        if receipt is None:
            raise RpcError(
                "NOT_FOUND", "CONVERSATION_NOT_FOUND", "Conversation not found"
            )
        return receipt

    async def close(self, name: str, request_id: str) -> Conversation:
        validate_request_id(request_id)
        receipt = await self.get(name)
        context = self.contexts.get(name)
        if context:
            await self._close(context, "closed")
            return context.receipt
        if receipt.state == "lost":
            # The supervised launch process dies with its original parent, including
            # its process group. A restarted service never resumes that SDK context.
            receipt = dataclasses.replace(receipt, state="closed")
            self.store.put(receipt)
        return receipt

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
            # The launch helper owns a process group containing hosted-tool helpers.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await asyncio.to_thread(process.wait, timeout=5)
        if context.directory is not None:
            context.directory.cleanup()

    async def _close(self, context: ExecutionContext, state: str) -> None:
        async with context.cleanup_lock:
            if context.receipt.state != "open":
                return
            context.closing = True
            current = asyncio.current_task()
            if context.task and context.task is not current:
                context.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await context.task
            await self._cleanup(context)
            context.receipt = dataclasses.replace(context.receipt, state=state)
            self.store.put(context.receipt)
            self.contexts.pop(context.receipt.name, None)
            if context.expiry and context.expiry is not current:
                context.expiry.cancel()

    async def shutdown(self) -> None:
        for context in tuple(self.contexts.values()):
            await self._close(context, "closed")

    async def generate(
        self, request: GenerateRequest, home: pathlib.Path
    ) -> Generation:
        self.validate_generate(request)
        budget = timeout_ms(request.timeout_ms)
        standalone = request.config is not None
        if standalone:
            validate_config(request.config)
            context = ExecutionContext(
                receipt=Conversation(),
                config=request.config,
                config_hash=fingerprint(request.config),
                deadline=time.monotonic() + budget / 1000,
            )
        else:
            receipt = await self.get(request.conversation)
            context = self.contexts.get(request.conversation)
            if not context or receipt.state != "open" or context.closing:
                raise RpcError(
                    "FAILED_PRECONDITION",
                    "CONVERSATION_CLOSED",
                    "Conversation is closed",
                )
            if context.lock.locked():
                raise RpcError(
                    "ABORTED", "CONVERSATION_BUSY", "Conversation has an active turn"
                )
        async with context.lock:
            return await self._generate(request, home, context, budget, standalone)

    async def _generate(
        self,
        request: GenerateRequest,
        home: pathlib.Path,
        context: ExecutionContext,
        budget: int,
        standalone: bool,
    ) -> Generation:
        started = datetime.now(UTC)
        tick = time.monotonic()
        context.task = asyncio.current_task()
        config = context.config
        params = config.parameters or Parameters()
        events = TurnEvents(context.totals, context.turns == 0, config.web_research)
        error = None
        state = "succeeded"
        cancelled = False
        upstream_started = False
        attempted = False
        try:
            async with asyncio.timeout(
                min(budget / 1000, max(0, context.deadline - tick))
            ):
                if standalone:
                    await self._open(context, home)
                options: dict[str, Any] = {}
                if params.effort:
                    options["effort"] = ReasoningEffort(params.effort)
                if config.output_schema_json:
                    options["output_schema"] = json.loads(config.output_schema_json)
                attempted = True
                context.turn = await context.thread.turn(request.input, **options)
                upstream_started = True
                context.turns += 1
                await events.collect(context.turn)
                if len(events.output.encode()) > MAX_GENERATION_OUTPUT_BYTES:
                    raise ValueError("output_too_large")
                if config.output_schema_json:
                    decoded = json.loads(events.output)
                    json.dumps(decoded, allow_nan=False)
                    jsonschema.Draft202012Validator(
                        json.loads(config.output_schema_json)
                    ).validate(decoded)
        except asyncio.CancelledError:
            state, cancelled = "cancelled", True
            error = {
                "code": 1,
                "message": "Model execution cancelled",
                "reason": "MODEL_CANCELLED",
            }
            if context.turn is not None:
                await _interrupt(context.turn)
        except TimeoutError:
            state = "failed"
            error = {
                "code": 4,
                "message": "Model execution timed out",
                "reason": "MODEL_TIMEOUT",
            }
            if context.turn is not None:
                await _interrupt(context.turn)
        except (ValueError, TypeError, jsonschema.ValidationError):
            state = "failed"
            error = {
                "code": 13,
                "message": "Model returned an invalid answer",
                "reason": "MODEL_INVALID_ANSWER",
            }
        except Exception as exc:
            state = "failed"
            kind = failure_code(exc)
            code = 16 if kind == "codex_auth" else 8 if kind == "codex_quota" else 14
            reason = {16: "MODEL_AUTH", 8: "MODEL_QUOTA", 14: "MODEL_UNAVAILABLE"}[code]
            error = {
                "code": code,
                "message": "Model execution unavailable",
                "reason": reason,
            }
        finally:
            # A missing turn snapshot breaks the next call's cumulative baseline.
            context.totals = None if events.usage_invalid else events.latest
            if standalone:
                await self._cleanup(context)
            context.turn = None
            context.task = None
        if not standalone and state != "succeeded" and not context.closing:
            await self._close(context, "closed")
        result = Generation(
            name=f"requests/{request.request_id}",
            model=config.model,
            reported_model=events.reported_model,
            state=state,
            output=events.output if state == "succeeded" else "",
            usage=events.usage(),
            observations=events.observations(),
            error=ModelError(**error) if error else None,
            conversation=request.conversation,
            parameters=params,
            started_at=timestamp(started),
            completed_at=timestamp(datetime.now(UTC)),
            duration_ms=min(2**31 - 1, int((time.monotonic() - tick) * 1000)),
            metadata=request.metadata,
            upstream_started=upstream_started,
            attempt_count=int(attempted),
            finish_reason="complete" if state == "succeeded" else "interrupted",
        )
        if cancelled:
            raise asyncio.CancelledError
        return result
