"""Provider-reported usage, isolated from model content and durable via a sink.

Codex emits cumulative thread/tokenUsage/updated snapshots. Each execute
starts a new thread; correction turns reuse it. Replace its total, never add
snapshots or add cached/reasoning subsets again. SDK turn counts are not counts
of underlying model requests. Missing or interrupted reports are not zero.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
import contextlib
import contextvars
import copy
import logging
from typing import cast, Literal, TypedDict
import uuid

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
    """Latest cumulative counters and completeness for one Codex invocation."""

    id: str
    provider: Literal["codex"]
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
_CODEX: contextvars.ContextVar[CodexUsage | None] = contextvars.ContextVar(
    "codex_usage", default=None
)
_CountField = Literal[
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
]
_FIELDS: dict[_CountField, str] = {
    "input_tokens": "inputTokens",
    "cached_input_tokens": "cachedInputTokens",
    "output_tokens": "outputTokens",
    "reasoning_output_tokens": "reasoningOutputTokens",
    "total_tokens": "totalTokens",
}


def _counts(value: object) -> TokenCounts | None:
    if not isinstance(value, dict):
        return None
    fields = {name: value.get(wire) for name, wire in _FIELDS.items()}
    if any(
        type(n) is not int or not 0 <= n <= 2**63 - 1 for n in fields.values()
    ):
        return None
    return cast(TokenCounts, fields)


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


class CodexUsage:
    """One ephemeral thread, including all its bounded correction turns."""

    def __init__(self, model: str) -> None:
        scope = _SCOPE.get()
        self.sink = scope[0] if scope else None
        self.record = UsageRecord(
            id=str(uuid.uuid4()),
            provider="codex",
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
        self.turn_id: str | None = None
        self._turn_has_usage = False
        self._gap = False

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
        self.turn_id = None
        self._turn_has_usage = False
        self.record["turns_started"] += 1
        self.record["partial"] = True
        self._save()

    def bind_turn(self, thread_id: str | None, turn_id: str | None) -> None:
        """Bind provider identities used to reject unrelated usage events."""
        self.turn_id = turn_id
        if thread_id is not None:
            self.record["thread_id"] = thread_id

    def observe(self, method: str, payload: object) -> None:
        """Persist trusted cumulative events and retain gaps as partial usage.

        Malformed, decreasing, or unrelated counters never replace a trusted
        snapshot. A valid but inconsistent subset is retained with a gap flag.
        """
        if not isinstance(payload, dict):
            return
        if method == "thread/tokenUsage/updated":
            if (
                self.turn_id is not None
                and payload.get("turnId") != self.turn_id
            ) or (
                self.record["thread_id"] is not None
                and payload.get("threadId") != self.record["thread_id"]
            ):
                return
            usage = payload.get("tokenUsage")
            counts = (
                _counts(usage.get("total")) if isinstance(usage, dict) else None
            )
            previous = self.record["usage"]
            if counts is None or (
                previous is not None
                and any(counts[key] < previous[key] for key in _FIELDS)
            ):
                # Retain the last trusted snapshot, but never claim completeness
                # after malformed data, a counter reset, or protocol drift.
                self._gap = True
                self.record["partial"] = True
                self._save()
                return
            if not _consistent(counts):
                # Preserve provider-reported totals verbatim, flag inconsistent
                # subsets instead of manufacturing a replacement total.
                self._gap = True
            self.record["usage"] = counts
            self.record["usage_events"] += 1
            if not self._turn_has_usage:
                self.record["turns_with_usage"] += 1
                self._turn_has_usage = True
            self._save()
        elif method == "turn/completed":
            self.record["turns_completed"] += 1
            if not self._turn_has_usage:
                self._gap = True
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
def codex_usage(model: str) -> Iterator[CodexUsage]:
    """Track one invocation and finalize its partial state on interruption."""
    usage = CodexUsage(model)
    token = _CODEX.set(usage)
    success = False
    try:
        yield usage
        success = True
    finally:
        try:
            usage.finish(success)
        finally:
            _CODEX.reset(token)


def observe_codex_usage(method: str, payload: object) -> None:
    """Route a provider notification to this task's active usage tracker."""
    usage = _CODEX.get()
    if usage is not None:
        usage.observe(method, payload)


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
        f"Codex 已记录 {usage['total_tokens']:,} tokens（{detail}）"
        " · Todofy/Gemini 用量未计入。"
    )
