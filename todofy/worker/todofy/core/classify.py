"""Map one Gemini HTTP attempt to what the summary step does next (v2 plan §5.3).

A failure tells the step whether to try the next model; with every model tried, the last
verdict's code is the step's.
"""

from dataclasses import dataclass
from enum import StrEnum

from .vocab import Code


class Failure(StrEnum):
    NOT_SENT = "not_sent"  # the request provably never left, e.g. connect refused
    TIMEOUT = "timeout"  # our deadline fired; the upstream may still act on it
    LOST = "lost"  # the connection broke after sending


@dataclass(frozen=True, slots=True)
class HttpOutcome:
    """Either an HTTP ``status`` or a transport ``failure``."""

    status: int | None = None
    failure: Failure | None = None
    retry_after: float = 0.0

    def __post_init__(self) -> None:
        if (self.status is None) == (self.failure is None):
            raise ValueError("an outcome has exactly one of status and failure")

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300


@dataclass(frozen=True, slots=True)
class GeminiVerdict:
    ok: bool
    code: Code | None = None
    next_model: bool = False  # this failure is specific to the model, try the next one
    retry_after: float = 0.0


def classify_gemini(outcome: HttpOutcome, text: str | None) -> GeminiVerdict:
    """``text`` is the first candidate's text of a 2xx response, if any.

    With every model tried, the last verdict's code is the step's code.
    """
    if outcome.ok:
        if text and text.strip():
            return GeminiVerdict(ok=True)
        return GeminiVerdict(ok=False, code=Code.SUMMARY_FAILED, next_model=True)
    status = outcome.status
    if status == 429:
        return GeminiVerdict(ok=False, code=Code.LLM_QUOTA, next_model=True, retry_after=outcome.retry_after)
    if status is None or status >= 500:
        return GeminiVerdict(ok=False, code=Code.SUMMARY_FAILED, next_model=True)
    # 404 is usually a retired model name; 400/401/403 fail the same on every model.
    return GeminiVerdict(ok=False, code=Code.LLM_REQUEST_REJECTED, next_model=status == 404)
