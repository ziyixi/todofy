"""Daily report rules shared by precompute and the newsletter endpoints (v2 plan §5.3).

The reports are proto/todofy/report/v1/report.proto (recommendation-v1, summary-v1): every report is built
as a generated message (``ziyixi_proto.todofy.report.v1``) and written with the wire codec, which checks the
contract's value rules (the newsletter's acceptance rules) before a byte is stored or served. The bounds,
window, formats and empty-window sentence are read where the IDL states them; they are the Go handlers'
values (handle_summary.go, handle_recommendation.go @ 6c46ed4). Unlike Go, an unparsable recommendation is
reported as ``model_output_invalid`` with no tasks instead of being passed through as a fake task. What the
IDL cannot say stays here: ranks unique and at most top_n. The reports are plain dicts (``to_wire``) whose
``json.dumps(..., ensure_ascii=False)`` is what D1 stores and the newsletter reads; tests pin their bytes
(tests/unit/test_report_wire.py).
"""

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from ziyixi_proto.todofy.report.v1 import report_pb as pb
from ziyixi_proto.wire_json import field_rules, format_matches, to_wire, wire_member, wire_name

DEFAULT_TOP_N = 3
# The newsletter discards larger responses (newsletter todofy.py _MAX_RESPONSE_BYTES).
MAX_RESPONSE_BYTES = 128 * 1024
# The contract's bounds and constants, read where report.proto states them.
MAX_TOP_N = int(field_rules(pb.RecommendationReport, "top_n").maximum or 0)
WINDOW_HOURS = int(field_rules(pb.SummaryReport, "time_window_hours").maximum or 0)
TITLE = pb.FORMATS["Title"]
REASON = pb.FORMATS["Reason"]
SUMMARY_TEXT = pb.FORMATS["SummaryText"]
MAX_TITLE_CHARS = TITLE.max_length
MAX_REASON_CHARS = REASON.max_length
MAX_SUMMARY_CHARS = SUMMARY_TEXT.max_length
# The summary of an empty window: the one value its case allows (the Go service's sentence).
(EMPTY_WINDOW_SUMMARY,) = next(
    case.bounds.allowed for case in field_rules(pb.SummaryReport, "summary").cases if "empty_window" in case.when
)

_INTEGER = re.compile(r"[+-]?[0-9]+")
# The control characters fit_summary drops from model text (the newsletter drops a whole section when any text
# holds one). Only a cleanup: what a report may hold is the contract's formats (Title, Reason, SummaryText), which
# the codec checks on every write.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# todofy.report.v1.ReportStatus by its wire names (OK is "ok"), as D1's status column stores them.
ReportStatus = StrEnum("ReportStatus", [(member.name, wire_name(member)) for member in pb.ReportStatus if member != 0])
ReportStatus.__doc__ = "What a report is (todofy.report.v1.ReportStatus), by its wire names."


@dataclass(frozen=True, slots=True)
class Recommendation:
    rank: int
    title: str
    reason: str


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
    if not isinstance(title, str) or not isinstance(reason, str):
        return None
    if not format_matches(TITLE, title) or not format_matches(REASON, reason):
        return None
    return Recommendation(rank, title, reason)


def summary_report(summary: str, task_count: int, status: str, model: str, stamps: Mapping[str, str]) -> dict:
    """The summary-v1 report (``stamps``: computed_at, window_start, window_end) as wire JSON.

    Raises ``WireJsonError`` when it breaks a rule of the contract: a bug, never a report to store.
    """
    return to_wire(
        pb.SummaryReport(
            summary=summary,
            task_count=task_count,
            time_window_hours=WINDOW_HOURS,
            status=_status(status),
            model=model,
            computed_at=stamps["computed_at"],
            window_start=stamps["window_start"],
            window_end=stamps["window_end"],
        )
    )


def recommendation_report(
    tasks: Sequence[Recommendation],
    task_count: int,
    status: str,
    model: str,
    top_n: int,
    stamps: Mapping[str, str],
    counts: Mapping[str, int] | None = None,
) -> dict:
    """The recommendation-v1 report as wire JSON, with ``counts`` (new_count, carryover_count) when given. Raises
    ``WireJsonError`` on a broken rule, as summary_report does."""
    counts = counts or {}
    return to_wire(
        pb.RecommendationReport(
            tasks=tuple(pb.RecommendedTask(rank=t.rank, title=t.title, reason=t.reason) for t in tasks),
            model=model,
            task_count=task_count,
            status=_status(status),
            top_n=top_n,
            computed_at=stamps["computed_at"],
            window_start=stamps["window_start"],
            window_end=stamps["window_end"],
            new_count=counts.get("new_count"),
            carryover_count=counts.get("carryover_count"),
        )
    )


def recommendation_from_answer(
    text: str,
    task_count: int,
    model: str,
    top_n: int,
    stamps: Mapping[str, str],
    counts: Mapping[str, int],
    max_bytes: int = MAX_RESPONSE_BYTES,
) -> dict:
    """The recommendation of a model answer: ok with its tasks, or model_output_invalid without tasks when the answer
    is unusable or the report would be larger than ``max_bytes`` as the newsletter reads it (an empty list would read
    as "nothing important today")."""
    recommendations = parse_recommendations(text, top_n)
    if recommendations is not None:
        report = recommendation_report(recommendations, task_count, ReportStatus.OK, model, top_n, stamps, counts)
        if len(json.dumps(report, ensure_ascii=False).encode()) <= max_bytes:
            return report
    return recommendation_report([], task_count, ReportStatus.MODEL_OUTPUT_INVALID, model, top_n, stamps, counts)


def _status(status: str) -> pb.ReportStatus:
    """The generated enum member of a status's wire name (a ReportStatus, or its string)."""
    member = wire_member(pb.ReportStatus, str(status))
    if member is None:
        raise ValueError("not a report status")
    return member


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
