"""Collect final output and observed hosted web actions from pinned SDK events."""

import contextlib
from dataclasses import dataclass, field
from typing import Any

from ziyixi_proto.modelrouter.inference.v1.inference_pb import Observations, Usage

COUNTERS = {
    "input_tokens": "inputTokens",
    "output_tokens": "outputTokens",
    "cached_input_tokens": "cachedInputTokens",
    "cache_write_tokens": "cacheWriteInputTokens",
}


def plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True)
    return value


def counts(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    result = {
        key: value.get(wire, 0 if key == "cache_write_tokens" else None)
        for key, wire in COUNTERS.items()
    }
    if any(type(item) is not int or item < 0 for item in result.values()):
        return None
    return result


@dataclass
class TurnEvents:
    baseline: dict[str, int] | None
    first_turn: bool
    web_research: bool
    output: str | None = None
    latest: dict[str, int] | None = None
    usage_invalid: bool = False
    searched: bool = False
    opened_urls: set[str] = field(default_factory=set)
    completed: bool = False

    def usage(self) -> Usage:
        if self.usage_invalid or self.latest is None:
            return Usage(billing_kind="subscription")
        if self.baseline is None and not self.first_turn:
            return Usage(billing_kind="subscription")
        baseline = self.baseline or dict.fromkeys(COUNTERS, 0)
        delta = {name: self.latest[name] - baseline[name] for name in COUNTERS}
        if any(value < 0 for value in delta.values()):
            return Usage(billing_kind="subscription")
        return Usage(available=True, billing_kind="subscription", **delta)

    def observations(self) -> Observations:
        return Observations(
            searched=self.searched, opened_urls=tuple(sorted(self.opened_urls))
        )

    def observe(self, method: str, payload: dict[str, Any], turn: Any) -> None:
        if payload.get("threadId") not in (None, getattr(turn, "thread_id", None)):
            return
        if payload.get("turnId") not in (None, getattr(turn, "id", None)):
            return
        if method == "thread/tokenUsage/updated":
            current = counts((payload.get("tokenUsage") or {}).get("total"))
            prior = self.latest or self.baseline
            if current is None or (
                prior and any(current[name] < prior[name] for name in COUNTERS)
            ):
                self.usage_invalid = True
            else:
                self.latest = current
        elif method == "item/completed":
            item = payload.get("item") or {}
            kind = item.get("type")
            if kind == "agentMessage" and item.get("phase") in (None, "final_answer"):
                self.output = item.get("text")
            elif kind == "webSearch" and self.web_research:
                action = item.get("action") or {}
                self.searched |= action.get("type") == "search"
                if action.get("type") == "openPage" and isinstance(
                    action.get("url"), str
                ):
                    self.opened_urls.add(action["url"])
            elif kind not in {"userMessage", "agentMessage", "reasoning"}:
                raise ValueError("unexpected_tool")
        elif method == "model/rerouted":
            if isinstance(payload.get("toModel"), str):
                # Fallback is never implicitly authorized by a research turn.
                raise ValueError("unexpected_model_fallback")
        elif method == "turn/completed":
            result = payload.get("turn") or {}
            if result.get("status") != "completed":
                raise RuntimeError(str(result.get("error") or "unavailable"))
            self.completed = True

    async def collect(self, turn: Any) -> None:
        async with contextlib.aclosing(turn.stream()) as stream:
            async for event in stream:
                payload = plain(event.payload)
                if not isinstance(payload, dict):
                    raise ValueError("invalid_event")
                self.observe(event.method, payload, turn)
        if not self.completed or not isinstance(self.output, str):
            raise ValueError("missing_final_answer")
