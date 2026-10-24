"""One ephemeral SDK turn classifies the complete claimed batch."""

import asyncio
import hashlib
import importlib
import json
import tempfile
from pathlib import Path

from ziyixi_proto.mailsort.runner.v1 import mailsort_runner_service_pb as api

from mailsort_runner import runtime
from mailsort_runner.settings import EFFORT, MODEL, RunnerError
from mailsort_runner.usage import Usage

PROMPT = Path(__file__).with_name("prompt.txt").read_text(encoding="utf-8")
PROMPT_SHA = hashlib.sha256(PROMPT.encode()).hexdigest()


def output_schema(messages: tuple[api.ClassificationMessage, ...]) -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "id": {
                            "type": "string",
                            "enum": [message.message_id for message in messages],
                        },
                        "bucket": {"type": "string", "enum": ["P1", "P2", "P3", "P4"]},
                        "reason": {"type": "string"},
                    },
                    "required": ["id", "bucket", "reason"],
                },
            }
        },
        "required": ["items"],
    }


def model_input(messages: tuple[api.ClassificationMessage, ...], evaluated_at: str) -> str:
    return json.dumps(
        {
            "emails": [
                {
                    "id": message.message_id,
                    "thread_id": message.thread_id,
                    "evaluated_at": evaluated_at,
                    "time_zone": message.time_zone,
                    "received_at": message.received_at,
                    "subject": message.subject,
                    "sender": message.sender,
                    "snippet": message.snippet,
                    "body": message.body,
                    "body_truncated": message.body_truncated,
                    "to_code": message.to_code,
                    "category": message.category,
                }
                for message in messages
            ]
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def parse_results(
    text: str, messages: tuple[api.ClassificationMessage, ...]
) -> tuple[api.ClassificationResult, ...]:
    try:
        value = json.loads(text)
        if not isinstance(value, dict) or set(value) != {"items"}:
            raise ValueError
        items = value["items"]
        if not isinstance(items, list) or len(items) != len(messages):
            raise ValueError
        by_id = {}
        for item in items:
            if not isinstance(item, dict) or set(item) != {"id", "bucket", "reason"}:
                raise ValueError
            message_id, bucket, reason = item["id"], item["bucket"], item["reason"]
            if (
                not isinstance(message_id, str)
                or message_id in by_id
                or bucket not in ("P1", "P2", "P3", "P4")
                or not isinstance(reason, str)
                or not 1 <= len(reason.strip()) <= 160
            ):
                raise ValueError
            by_id[message_id] = api.ClassificationResult(
                message_id=message_id,
                priority=api.Priority[bucket],
                reason=reason.strip(),
            )
        if set(by_id) != {message.message_id for message in messages}:
            raise ValueError
        return tuple(by_id[message.message_id] for message in messages)
    except (ValueError, TypeError, KeyError):
        raise RunnerError("codex_failed") from None


def provider_error(value: object) -> str:
    """Map SDK provider evidence to a fixed code without logging its text."""
    if not isinstance(value, dict):
        return "codex_failed"
    info = value.get("codexErrorInfo", value.get("codex_error_info", value.get("code", "")))
    if info in (
        "usageLimitExceeded",
        "rateLimitExceeded",
        "usage_limit_reached",
        "rate_limit_exceeded",
    ):
        return "codex_quota_exhausted"
    if info in ("unauthorized", "invalid_api_key", "not_logged_in"):
        return "codex_not_logged_in"
    if info in ("model_not_found", "model_unavailable"):
        return "codex_model_unavailable"
    message = value.get("message", "")
    if isinstance(message, str):
        for evidence, code in (
            ("model_not_found", "codex_model_unavailable"),
            ("usage_limit_reached", "codex_quota_exhausted"),
            ("rate_limit_exceeded", "codex_quota_exhausted"),
        ):
            if evidence in message:
                return code
    return "codex_failed"


async def classify(
    messages: tuple[api.ClassificationMessage, ...],
    evaluated_at: str,
    home: Path,
    usage: Usage,
    *,
    sdk=None,
) -> tuple[api.ClassificationResult, ...]:
    sdk = sdk or runtime.load_sdk()
    v2 = importlib.import_module("openai_codex.generated.v2_all")
    completed = False
    try:
        with tempfile.TemporaryDirectory(prefix="mailsort-model-") as directory:
            workspace = Path(directory)
            async with (
                asyncio.timeout(840),
                sdk.AsyncCodex(runtime.config(sdk, home, workspace)) as client,
            ):
                account = await client.account(refresh_token=True)
                if account.account is None or account.account.root.type != "chatgpt":
                    raise RunnerError("codex_not_logged_in")
                # The low-level typed response retains the accepted model/effort.
                started = await client._client.thread_start(
                    v2.ThreadStartParams.model_validate(
                        {
                            "cwd": str(workspace),
                            "model": MODEL,
                            "modelProvider": "openai",
                            "sandbox": "read-only",
                            "approvalPolicy": "never",
                            "ephemeral": True,
                            "developerInstructions": PROMPT,
                            "config": {"model_reasoning_effort": EFFORT},
                        }
                    )
                )
                if started.model != MODEL or started.reasoning_effort != v2.ReasoningEffort.medium:
                    raise RunnerError("codex_model_unavailable")
                thread = sdk.AsyncThread(client, started.thread.id)
                turn = await thread.turn(
                    model_input(messages, evaluated_at),
                    model=MODEL,
                    effort=v2.ReasoningEffort.medium,
                    output_schema=output_schema(messages),
                )
                final = None
                error_code = "codex_failed"
                async for event in turn.stream():
                    payload = event.payload.model_dump(mode="json", by_alias=True)
                    if event.method == "thread/tokenUsage/updated":
                        usage.observe(payload, turn.thread_id, turn.id)
                    elif event.method == "item/completed":
                        item = payload.get("item", {})
                        if item.get("type") == "agentMessage" and item.get("phase") in (
                            None,
                            "final_answer",
                        ):
                            final = item.get("text")
                    elif event.method == "turn/completed":
                        completed = payload.get("turn", {}).get("status") == "completed"
                        error_code = provider_error(payload.get("turn", {}).get("error"))
                if not completed or not isinstance(final, str):
                    raise RunnerError(error_code)
                return parse_results(final, messages)
    except TimeoutError:
        raise RunnerError("codex_failed") from None
    except RunnerError:
        raise
    except Exception as error:
        # SDK exceptions may contain the model input or provider response.
        details = getattr(error, "data", None)
        if not isinstance(details, dict):
            details = {"message": getattr(error, "message", "")}
        raise RunnerError(provider_error(details)) from None
    finally:
        usage.finish(completed)
