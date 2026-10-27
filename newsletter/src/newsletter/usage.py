"""Provider-reported usage, isolated from model content and durable via a sink.

The router returns per-call counts. Correction calls share one invocation and
add their distinct final receipts once. Missing/interrupted usage is unknown.
Historical stored provider labels and invocation IDs remain unchanged.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
import contextlib
import contextvars
import copy
import logging
from typing import cast, Literal, TypedDict
import uuid

import model_router_client as models

import newsletter.diagnostics as diagnostics

_LOGGER = logging.getLogger(__name__)


class TokenCounts(TypedDict):
    """Provider totals whose cached and reasoning counts are subsets."""

    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    reasoning_output_tokens: int
    total_tokens: int


class UsageRecord(TypedDict):
    """Normalized totals and completeness for one model invocation."""

    id: str
    provider: Literal["codex", "model_router"]
    model: str
    stage: str
    thread_id: str | None
    status: Literal["running", "completed", "failed"]
    usage: TokenCounts | None
    turns_started: int
    turns_completed: int
    turns_with_usage: int
    usage_events: int
    partial: bool


class UsageSummary(TypedDict):
    """Aggregated invocation totals, retaining missing and partial reports."""

    usage: TokenCounts | None
    invocations: int
    missing_invocations: int
    partial: bool


UsageSink = Callable[[UsageRecord], None]
_SCOPE: contextvars.ContextVar[tuple[UsageSink, str] | None] = (
    contextvars.ContextVar("usage_scope", default=None)
)
_CountField = Literal[
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
]
_FIELDS: tuple[_CountField, ...] = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


def _consistent(counts: TokenCounts) -> bool:
    return (
        counts["total_tokens"]
        == counts["input_tokens"] + counts["output_tokens"]
        and counts["cached_input_tokens"] <= counts["input_tokens"]
        and counts["reasoning_output_tokens"] <= counts["output_tokens"]
    )


@contextlib.contextmanager
def usage_scope(sink: UsageSink, stage: str) -> Iterator[None]:
    """Attach a persistence sink to this task, not global process state."""
    token = _SCOPE.set((sink, stage))
    try:
        yield
    finally:
        _SCOPE.reset(token)


class ModelUsage:
    """One remote context, including its bounded correction calls."""

    def __init__(self, model: str) -> None:
        scope = _SCOPE.get()
        self.sink = scope[0] if scope else None
        self.record = UsageRecord(
            id=str(uuid.uuid4()),
            provider="model_router",
            model=model,
            stage=scope[1] if scope else "unscoped",
            thread_id=None,
            status="running",
            usage=None,
            turns_started=0,
            turns_completed=0,
            turns_with_usage=0,
            usage_events=0,
            partial=True,
        )
        self._gap = False
        self._seen: set[str] = set()

    def _save(self) -> None:
        if self.sink is not None:
            try:
                self.sink(copy.deepcopy(self.record))
            # A user-supplied sink may fail with any implementation exception.
            except Exception as error:  # noqa: BLE001
                diagnostics.record_failure(
                    _LOGGER,
                    phase="usage_save",
                    error=error,
                    reference=self.record["id"],
                )
                # A failed write must not yield an accepted durable total.
                raise RuntimeError("usage_recording_failed") from None

    def start_turn(self) -> None:
        """Persist a new turn attempt before the provider is invoked."""
        self.record["turns_started"] += 1
        self.record["partial"] = True
        self._save()

    def bind_turn(self, thread_id: str | None) -> None:
        """Keep the context identity in the existing invocation history."""
        if thread_id is not None:
            self.record["thread_id"] = thread_id

    def observe_generation(self, generation: models.Generation) -> None:
        """Add one normalized call once; cached/reasoning remain subsets."""
        if generation.name in self._seen:
            return
        self._seen.add(generation.name)
        self.record["turns_completed"] += 1
        reported = generation.usage
        if reported is None or not reported.available:
            self._gap = True
        else:
            values = TokenCounts(
                input_tokens=reported.input_tokens,
                cached_input_tokens=reported.cached_input_tokens,
                output_tokens=reported.output_tokens,
                # Legacy field; thinking remains included in output.
                reasoning_output_tokens=0,
                total_tokens=reported.input_tokens + reported.output_tokens,
            )
            previous = self.record["usage"]
            self.record["usage"] = cast(
                TokenCounts,
                {
                    key: values[key] + (previous[key] if previous else 0)
                    for key in _FIELDS
                },
            )
            self.record["usage_events"] += 1
            self.record["turns_with_usage"] += 1
            self._gap |= not _consistent(values)
        self._save()

    def finish(self, success: bool) -> None:
        """Persist invocation completion without inventing missing counters."""
        if not self.record["turns_started"]:
            return  # Startup/authentication made no model attempt.
        self.record["status"] = "completed" if success else "failed"
        self.record["partial"] = bool(
            self._gap
            or not success
            or self.record["usage"] is None
            or self.record["turns_started"] != self.record["turns_completed"]
        )
        self._save()


@contextlib.contextmanager
def model_usage(model: str) -> Iterator[ModelUsage]:
    """Track one invocation and finalize its partial state on interruption."""
    usage = ModelUsage(model)
    success = False
    try:
        yield usage
        success = True
    finally:
        usage.finish(success)


def summarize_usage(records: Sequence[UsageRecord]) -> UsageSummary:
    """Sum latest durable invocations, not successive updates of the same ID."""
    latest = {record["id"]: record for record in records}
    known = [r["usage"] for r in latest.values() if r["usage"] is not None]
    totals = (
        TokenCounts(
            input_tokens=sum(r["input_tokens"] for r in known),
            cached_input_tokens=sum(r["cached_input_tokens"] for r in known),
            output_tokens=sum(r["output_tokens"] for r in known),
            reasoning_output_tokens=sum(
                r["reasoning_output_tokens"] for r in known
            ),
            total_tokens=sum(r["total_tokens"] for r in known),
        )
        if known
        else None
    )
    return UsageSummary(
        usage=totals,
        invocations=len(latest),
        missing_invocations=len(latest) - len(known),
        partial=not latest
        or any(
            r["partial"] or r["status"] != "completed" for r in latest.values()
        ),
    )


def normalize_usage_summary(value: object) -> UsageSummary:
    """Validate internal ints or public protobuf JSON uint64 strings."""
    if not isinstance(value, dict):
        raise ValueError("invalid_usage_summary")

    def number(number: object) -> int:
        if isinstance(number, str) and number.isascii() and number.isdigit():
            number = int(number) if len(number) <= 20 else -1
        if type(number) is not int or not 0 <= number <= 2**64 - 1:
            raise ValueError("invalid_usage_summary")
        return number

    raw = value.get("usage")
    usage: TokenCounts | None = None
    if raw is not None:
        if not isinstance(raw, dict) or set(raw) - set(_FIELDS):
            raise ValueError("invalid_usage_summary")
        usage = cast(
            TokenCounts, {key: number(raw.get(key, 0)) for key in _FIELDS}
        )
    partial = value.get("partial", False)
    if type(partial) is not bool:
        raise ValueError("invalid_usage_summary")
    invocations = number(value.get("invocations", 0))
    missing = number(value.get("missing_invocations", 0))
    if missing > invocations or set(value) - {
        "usage",
        "invocations",
        "missing_invocations",
        "partial",
    }:
        raise ValueError("invalid_usage_summary")
    return UsageSummary(
        usage=usage,
        invocations=invocations,
        missing_invocations=missing,
        partial=partial
        or usage is None
        or missing > 0
        or not _consistent(usage),
    )


def usage_footer(
    summary: UsageSummary | None, *, is_fixture: bool = False
) -> str:
    """Format reported totals, explicitly marking mock or incomplete usage."""
    if summary is None:
        return ""
    if is_fixture:
        return "MOCK · 用量统计仅为流程演示，不代表真实模型消耗。"
    usage = summary["usage"]
    if usage is None:
        return "模型用量未取得 · Todofy/Gemini 用量未计入。"
    consistent = _consistent(usage)
    detail = (
        f"非缓存输入 {usage['input_tokens'] - usage['cached_input_tokens']:,}"
        f" · 缓存输入 {usage['cached_input_tokens']:,}"
        f" · 输出 {usage['output_tokens']:,}"
        if consistent
        else "用量分类不一致，输入/输出拆分不可确定"
    )
    if summary["partial"] or not consistent:
        detail += "；部分用量，未含未返回用量的调用"
    return (
        f"模型已记录 {usage['total_tokens']:,} tokens（{detail}）"
        " · Todofy/Gemini 用量未计入。"
    )
