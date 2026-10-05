"""Gemini ``generateContent`` with the model fallback chain (v2 plan §5.3 step A).

One call is one step: models are tried in the caller's order (default ``GEMINI_MODELS``) while the
verdict says the failure is model-specific, all inside the caller's deadline.
Retries across alarms (and their backoff) belong to the caller.
"""

from dataclasses import dataclass
from typing import Any

from todofy.core import gemini_wire
from todofy.core.backoff import GEMINI_MODEL_TIMEOUT
from todofy.core.classify import Failure, GeminiVerdict, HttpOutcome, classify_gemini
from todofy.runtime.config import gemini_models, integer, var
from todofy.runtime.interop import fetch_with_timeout, now_ms

# Below this an attempt cannot finish a real generation; stop instead of burning a call.
MIN_ATTEMPT_MS = 1000


@dataclass(frozen=True, slots=True)
class GeminiResult:
    verdict: GeminiVerdict  # from the last model tried
    text: str  # first candidate text when ok, else ""
    model: str  # model that answered (or the last one tried)
    tokens: int  # usageMetadata.totalTokenCount summed over attempts
    prompt_tokens: int = 0  # usageMetadata.promptTokenCount summed over attempts
    attempts: int = 0  # requests sent (one per model tried)


async def generate(
    env: Any,
    *,
    system: str,
    user: str,
    deadline_ms: int,
    response_schema: dict | None = None,
    preface: str = "",
    models: list[str] | None = None,
) -> GeminiResult:
    """``deadline_ms`` is an absolute epoch-ms deadline (e.g. ``now_ms() + 90_000``).

    ``user`` is untrusted content and always sent fenced (``gemini_wire.user_turn``);
    ``preface`` is our own text placed before the fence, such as the truncation notice.
    """
    base = var(env, "GEMINI_API_BASE", "https://generativelanguage.googleapis.com").rstrip("/")
    headers = {"content-type": "application/json", "x-goog-api-key": var(env, "GEMINI_API_KEY")}
    body = gemini_wire.build_request(system, gemini_wire.user_turn(user, preface), response_schema)
    model_timeout_ms = integer(env, "GEMINI_TIMEOUT_MS", GEMINI_MODEL_TIMEOUT * 1000)
    models = gemini_models(env) if models is None else models

    # Reported when the deadline leaves no room for even one attempt.
    result = GeminiResult(
        classify_gemini(HttpOutcome(failure=Failure.TIMEOUT), None), "", models[0] if models else "", 0
    )
    tokens = prompt_tokens = 0
    for attempts, model in enumerate(models, start=1):
        remaining = deadline_ms - now_ms()
        if remaining < MIN_ATTEMPT_MS:
            break
        upstream = await fetch_with_timeout(
            base + gemini_wire.generate_path(model),
            timeout_ms=min(model_timeout_ms, remaining),
            method="POST",
            headers=headers,
            body=body,
        )
        reply = gemini_wire.parse_reply(upstream.body)
        tokens += reply.tokens
        prompt_tokens += reply.prompt_tokens
        verdict = classify_gemini(upstream.outcome(), reply.text)
        result = GeminiResult(verdict, reply.text if verdict.ok else "", model, tokens, prompt_tokens, attempts)
        if verdict.ok or not verdict.next_model:
            break
    return result
