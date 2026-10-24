"""Replace cumulative provider snapshots; never sum repeated notifications."""

from dataclasses import dataclass


@dataclass
class Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    partial: bool = True
    _gap: bool = False

    def observe(self, payload: dict, thread_id: str, turn_id: str) -> None:
        if payload.get("threadId") != thread_id or payload.get("turnId") != turn_id:
            return
        counts = payload.get("tokenUsage", {}).get("total", {})
        incoming = (counts.get("inputTokens"), counts.get("outputTokens"))
        if any(type(value) is not int or not 0 <= value < 2**31 for value in incoming):
            self._gap = True
            return
        if self.input_tokens is not None and (
            incoming[0] < self.input_tokens or incoming[1] < self.output_tokens
        ):
            self._gap = True
            return
        self.input_tokens, self.output_tokens = incoming

    def finish(self, completed: bool) -> None:
        self.partial = not completed or self.input_tokens is None or self._gap
