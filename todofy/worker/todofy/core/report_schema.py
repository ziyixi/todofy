"""Daily report rules shared by precompute and the newsletter endpoints (v2 plan §5.3).

The top-N limits, window and empty-window sentence are the Go handlers' values
(handle_summary.go, handle_recommendation.go @ 6c46ed4). Unlike Go, an
unparsable recommendation is reported as ``model_output_invalid`` with no
tasks instead of being passed through as a fake task.
"""

import json
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

DEFAULT_TOP_N = 3
MAX_TOP_N = 10
WINDOW_HOURS = 24
MAX_TITLE_CHARS = 200
MAX_REASON_CHARS = 4000
MAX_SUMMARY_CHARS = 12_000

EMPTY_WINDOW_SUMMARY = (
    "As there is no new task in the last 24 hours, there will have no summary. "
    "Please check your service as it's highly not possible that there is no new task in the last 24 hours.\n"
)

_INTEGER = re.compile(r"[+-]?[0-9]+")
# The newsletter drops a whole section when any text holds one of these.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class ReportStatus(StrEnum):
    OK = "ok"
    EMPTY_WINDOW = "empty_window"
    MODEL_OUTPUT_INVALID = "model_output_invalid"
    STALE = "stale"


@dataclass(frozen=True, slots=True)
class Recommendation:
    rank: int
    title: str
    reason: str


def newsletter_text_ok(text: object, max_chars: int) -> bool:
    """Non-blank text the newsletter accepts (its _decode rules)."""
    return isinstance(text, str) and bool(text.strip()) and len(text) <= max_chars and not _CONTROL.search(text)


# Appended when a long daily summary is cut to fit the newsletter.
SUMMARY_TRUNCATED_NOTICE = "\n（列表过长，已截断以适应 newsletter。）"


def fit_summary(text: str, max_chars: int = MAX_SUMMARY_CHARS) -> str | None:
    """Model text made acceptable to the newsletter, or None when nothing usable is left.

    Control characters are dropped. Text over ``max_chars`` is cut at the last
    line break that leaves room for SUMMARY_TRUNCATED_NOTICE (or hard, when a
    single line is that long), so a long day still gets a summary instead of a
    failed run that would be retried all day.
    """
    cleaned = _CONTROL.sub("", text)
    if not cleaned.strip():
        return None
    if len(cleaned) <= max_chars:
        return cleaned
    head = cleaned[: max_chars - len(SUMMARY_TRUNCATED_NOTICE)]
    if (cut := head.rfind("\n")) > 0:
        head = head[:cut]
    head = head.rstrip()
    return head + SUMMARY_TRUNCATED_NOTICE if head.strip() else None


def parse_top_n(value: str | None) -> int:
    """The ``top`` query parameter: absent or empty means the default; else 1..10."""
    if not value:
        return DEFAULT_TOP_N
    if not _INTEGER.fullmatch(value) or not 1 <= int(value) <= MAX_TOP_N:
        raise ValueError(f"top must be 1-{MAX_TOP_N}")
    return int(value)


def parse_recommendations(model_output: str, top_n: int) -> list[Recommendation] | None:
    """Validated recommendations ordered by rank, or None if the output is unusable.

    Fewer than ``top_n`` items (even none) are valid and never padded.
    """
    raw = model_output.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        items = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(items, list) or len(items) > top_n:
        return None
    recommendations: list[Recommendation] = []
    for item in items:
        if (recommendation := _recommendation(item, top_n)) is None:
            return None
        recommendations.append(recommendation)
    if len({r.rank for r in recommendations}) != len(recommendations):
        return None
    return sorted(recommendations, key=lambda r: r.rank)


def _recommendation(item: Any, top_n: int) -> Recommendation | None:
    if not isinstance(item, dict):
        return None
    rank, title, reason = item.get("rank"), item.get("title"), item.get("reason")
    if type(rank) is not int or not 1 <= rank <= top_n:
        return None
    if not newsletter_text_ok(title, MAX_TITLE_CHARS) or not newsletter_text_ok(reason, MAX_REASON_CHARS):
        return None
    return Recommendation(rank, title, reason)


def recommendation_response_schema(top_n: int) -> dict[str, Any]:
    """Gemini ``responseSchema`` for the recommendation call."""
    return {
        "type": "ARRAY",
        "maxItems": top_n,
        "items": {
            "type": "OBJECT",
            "properties": {
                "rank": {"type": "INTEGER"},
                "title": {"type": "STRING"},
                "reason": {"type": "STRING"},
            },
            "required": ["rank", "title", "reason"],
            "propertyOrdering": ["rank", "title", "reason"],
        },
    }
