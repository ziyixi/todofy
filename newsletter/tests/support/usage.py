"""Shared offline usage builders and fakes."""

from __future__ import annotations

import newsletter.types as types
import newsletter.usage as newsletter_usage


def notification(
    input_tokens: int = 100,
    output_tokens: int = 20,
    cached: int = 60,
    reasoning: int = 10,
    **extra: object,
) -> types.Payload:
    """Build cumulative SDK usage, allowing malformed wire-field overrides."""
    counts = {
        "inputTokens": input_tokens,
        "cachedInputTokens": cached,
        "outputTokens": output_tokens,
        "reasoningOutputTokens": reasoning,
        "totalTokens": input_tokens + output_tokens,
        **extra,
    }
    return {
        "threadId": "thread-test",
        "turnId": "turn-test",
        "tokenUsage": {
            "total": counts,
            "last": counts,
            "modelContextWindow": 200000,
        },
    }


def observe(payload: types.Payload | None = None) -> None:
    """Submit a synthetic token-usage update to the active recorder."""
    newsletter_usage.observe_codex_usage(
        "thread/tokenUsage/updated", payload or notification()
    )


def complete() -> None:
    """Mark the synthetic recorder turn completed."""
    newsletter_usage.observe_codex_usage(
        "turn/completed", {"turn": {"id": "turn-test", "status": "completed"}}
    )


def record_one(
    payload: types.Payload | None = None,
) -> list[newsletter_usage.UsageRecord]:
    """Capture one synthetic invocation through the real usage sink."""
    records: list[newsletter_usage.UsageRecord] = []
    with (
        newsletter_usage.usage_scope(records.append, "research:synthetic"),
        newsletter_usage.codex_usage("fixture-model") as usage,
    ):
        usage.start_turn()
        usage.bind_turn("thread-test", "turn-test")
        observe(payload)
        complete()
    return records
