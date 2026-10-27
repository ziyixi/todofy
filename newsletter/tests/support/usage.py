"""Synthetic normalized model receipts shared by usage tests."""

import uuid

import model_router_client as models

import newsletter.usage as newsletter_usage


def notification(
    input_tokens: int = 100,
    output_tokens: int = 20,
    cached: int = 60,
    reasoning: int = 10,
    **extra: object,
) -> models.Generation:
    """Build one provider-neutral final usage receipt."""
    return models.Generation(
        name="requests/" + str(uuid.uuid4()),
        state="succeeded",
        usage=models.Usage(
            available=True,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_input_tokens=cached,
            reasoning_output_tokens=reasoning,
            total_tokens=input_tokens + output_tokens,
        ),
    )


def record_one(
    payload: models.Generation | None = None,
) -> list[newsletter_usage.UsageRecord]:
    """Capture one synthetic invocation through the real durable sink."""
    records: list[newsletter_usage.UsageRecord] = []
    with (
        newsletter_usage.usage_scope(records.append, "research:synthetic"),
        newsletter_usage.model_usage("fixture-model") as usage,
    ):
        usage.start_turn()
        usage.bind_turn("conversations/fixture", "request-test")
        usage.observe_generation(payload or notification())
    return records
