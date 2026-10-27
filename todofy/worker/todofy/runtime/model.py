"""Model Router transport; business prompts and summary failure handling stay in Todofy."""

import asyncio
import uuid
from dataclasses import dataclass
from typing import Any

import js
from model_router_client import (
    GenerateRequest,
    GenerationConfig,
    HttpCall,
    HttpResult,
    Instruction,
    ModelClient,
    ModelRouterError,
    Parameters,
)

from todofy.core import model_input
from todofy.core.classify import GeminiVerdict
from todofy.core.vocab import Code
from todofy.runtime.config import integer
from todofy.runtime.interop import now_ms, read_capped, to_js


def client(env: Any, deadline_ms: int | None = None) -> ModelClient:
    async def transport(call: HttpCall) -> HttpResult:
        timeout_ms = int(call.timeout_seconds * 1000)
        if deadline_ms is not None:
            timeout_ms = min(timeout_ms, deadline_ms - now_ms())
        if timeout_ms <= 0:
            raise ModelRouterError("DEADLINE_EXCEEDED")
        controller = js.AbortController.new()
        options = {
            "method": call.method,
            "headers": {"content-type": "application/json"},
            "signal": controller.signal,
        }
        if call.body is not None:
            options["body"] = call.body.decode()
        request = js.Request.new("https://model-router.internal" + call.path, to_js(options))
        try:
            async with asyncio.timeout(timeout_ms / 1000):
                response = await env.MODEL_ROUTER.fetch(request)
                body = await read_capped(response.body, 3 << 20)
        except TimeoutError:
            raise ModelRouterError("DEADLINE_EXCEEDED") from None
        except (OSError, AttributeError) as exc:
            raise ModelRouterError("UNAVAILABLE") from exc
        finally:
            controller.abort()
        if body is None:
            raise ModelRouterError("UNAVAILABLE", "MODEL_ROUTER_INVALID_RESPONSE")
        return HttpResult(int(response.status), body)

    return ModelClient(transport)


@dataclass(frozen=True, slots=True)
class ModelResult:
    verdict: GeminiVerdict
    text: str
    model: str
    tokens: int
    prompt_tokens: int = 0
    attempts: int = 0
    usage_available: bool = False


async def generate(
    env: Any,
    *,
    system: str,
    user: str,
    deadline_ms: int,
    model: str,
    response_schema: dict | None = None,
    preface: str = "",
) -> ModelResult:
    import json

    if deadline_ms <= now_ms():
        return ModelResult(GeminiVerdict(False, Code.SUMMARY_FAILED), "", model, 0, usage_available=True)

    deadline_ms = min(deadline_ms, now_ms() + integer(env, "MODEL_TIMEOUT_MS", 180000))
    request = GenerateRequest(
        request_id=str(uuid.uuid4()),
        config=GenerationConfig(
            model=model,
            instructions=(Instruction(text=system, cache=True),),
            parameters=Parameters(allow_fallback=True),
            output_schema_json="" if response_schema is None else json.dumps(response_schema),
        ),
        input=model_input.user_turn(user, preface),
        timeout_ms=max(1000, min(840000, deadline_ms - now_ms())),
    )
    try:
        answer = await client(env, deadline_ms).generate(request)
    except ModelRouterError as error:
        rejected = error.code in {"INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "FAILED_PRECONDITION"}
        code = (
            Code.LLM_REQUEST_REJECTED
            if rejected
            else Code.LLM_QUOTA
            if error.code == "RESOURCE_EXHAUSTED"
            else Code.SUMMARY_FAILED
        )
        return ModelResult(GeminiVerdict(False, code), "", model, 0, usage_available=rejected)
    error = answer.error
    code = (
        None
        if error is None
        else (
            Code.LLM_QUOTA
            if error.reason in {"MODEL_QUOTA", "MODEL_RATE_LIMIT", "MODEL_SPEND_LIMIT"}
            else Code.LLM_REQUEST_REJECTED
            if error.reason in {"MODEL_AUTH", "MODEL_NOT_CONFIGURED"}
            else Code.SUMMARY_FAILED
        )
    )
    usage = answer.usage
    return ModelResult(
        GeminiVerdict(
            error is None and answer.state == "succeeded",
            code,
            retry_after=0 if error is None else error.retry_after_seconds,
        ),
        answer.output,
        answer.reported_model or answer.model,
        0 if usage is None else usage.total_tokens,
        0 if usage is None else usage.input_tokens,
        answer.attempt_count,
        usage is not None and usage.available,
    )
