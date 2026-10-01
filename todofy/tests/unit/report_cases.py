"""Synthetic inputs of the newsletter reports (api/summary-v1, api/recommendation-v1) whose exact bytes
tests/unit/test_report_wire.py pins: golden/reports-v1.json holds what the report code wrote for each before it
moved onto the generated proto/todofy/report/v1 messages. No real mail: every text is made up.

A case is (name, kind, input). kind ``summary`` and ``recommendation`` are a built report (status, counts and
tasks as given); ``parsed`` is a model answer turned into a recommendation (an unusable one becomes
model_output_invalid without the counts).
"""

import json
from typing import Any

from todofy.core.report_schema import EMPTY_WINDOW_SUMMARY, MAX_REASON_CHARS, MAX_TITLE_CHARS, fit_summary

STAMPS = {
    "computed_at": "2026-09-28T13:30:00Z",
    "window_start": "2026-09-27T13:30:00Z",
    "window_end": "2026-09-28T13:30:00Z",
}
MODEL = "gemini-3.8-flash"
# Longer than the newsletter takes: fit_summary cuts it at a line break and appends its notice.
LONG_DAY = "\n".join(f"- item {n}: renew the example contract" for n in range(1, 600))
TASKS = [
    {"rank": 1, "title": "报税截止", "reason": "今天必须提交"},
    {"rank": 2, "title": "Renew the passport", "reason": "Expires next week.\nBook an appointment."},
    {"rank": 3, "title": '续签合同 "A"', "reason": "对方 10 月 15 日前需要回复\t（示例）"},
]
# A task at both length limits, and nine short ones: ten tasks, ranks 1-10.
LONG_REASON = ("Why it matters.\n" * 300)[: MAX_REASON_CHARS - 1] + "。"
AT_THE_LIMITS = [
    {"rank": 1, "title": "T" * (MAX_TITLE_CHARS - 1) + "题", "reason": LONG_REASON},
    *({"rank": n, "title": f"示例任务 {n}", "reason": f"原因 {n}"} for n in range(2, 11)),
]


def _summary(text: str, count: int, status: str, model: str = MODEL) -> dict[str, Any]:
    return {"text": text, "count": count, "status": status, "model": model, "stamps": STAMPS}


def _recommendation(
    tasks: list[dict[str, Any]], count: int, status: str, top_n: int, counts: dict[str, int] | None, model: str = MODEL
) -> dict[str, Any]:
    return {"tasks": tasks, "count": count, "status": status, "model": model, "top_n": top_n, "counts": counts}


def _parsed(text: str, count: int, top_n: int, counts: dict[str, int]) -> dict[str, Any]:
    return {"text": text, "count": count, "model": MODEL, "top_n": top_n, "counts": counts}


CASES: list[tuple[str, str, dict[str, Any]]] = [
    ("summary_ok_ascii", "summary", _summary("Important\n- Renew the passport\n- File the quarterly report", 4, "ok")),
    ("summary_ok_chinese_tab", "summary", _summary("重要\n\t- 报税截止\n- 续签护照（下周）\r\n", 63, "ok")),
    ("summary_ok_unicode_space_first", "summary", _summary("　报告：一项 两行", 1, "ok")),
    ("summary_ok_fitted_long_day", "summary", _summary(fit_summary(LONG_DAY) or "", 599, "ok")),
    ("summary_ok_escapes", "summary", _summary('Quotes " and \\ backslash, emoji 😀, slash /', 2, "ok")),
    ("summary_empty_window", "summary", _summary(EMPTY_WINDOW_SUMMARY, 0, "empty_window", model="")),
    (
        "recommendation_ok_three_with_carryover",
        "recommendation",
        _recommendation(TASKS, 5, "ok", 3, {"new_count": 3, "carryover_count": 2}),
    ),
    (
        "recommendation_ok_none_worth_it",
        "recommendation",
        _recommendation([], 4, "ok", 10, {"new_count": 4, "carryover_count": 0}),
    ),
    (
        "recommendation_ok_only_carried",
        "recommendation",
        _recommendation(TASKS[:1], 4, "ok", 1, {"new_count": 0, "carryover_count": 4}),
    ),
    (
        "recommendation_ok_ten_at_the_limits",
        "recommendation",
        _recommendation(AT_THE_LIMITS, 1000, "ok", 10, {"new_count": 970, "carryover_count": 30}),
    ),
    (
        "recommendation_empty_window",
        "recommendation",
        _recommendation([], 0, "empty_window", 3, {"new_count": 0, "carryover_count": 0}, model=""),
    ),
    (
        "recommendation_model_output_invalid",
        "recommendation",
        _recommendation([], 7, "model_output_invalid", 5, None),
    ),
    ("recommendation_parsed_unusable", "parsed", _parsed("not json", 7, 5, {"new_count": 5, "carryover_count": 2})),
    (
        "recommendation_parsed_ok",
        "parsed",
        _parsed(json.dumps(TASKS[::-1], ensure_ascii=False), 5, 3, {"new_count": 3, "carryover_count": 2}),
    ),
]
