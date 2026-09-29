"""api/summary-v1 and recommendation-v1: the newsletter-facing report contracts.

Both schemas encode the newsletter's acceptance rules, so everything the Worker
may emit must validate; they are also tied to the constants in core/report_schema.py.
"""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from todofy.core.prompts import RECOMMEND_TOP_TASKS
from todofy.core.report_schema import (
    EMPTY_WINDOW_SUMMARY,
    MAX_REASON_CHARS,
    MAX_SUMMARY_CHARS,
    MAX_TITLE_CHARS,
    MAX_TOP_N,
    WINDOW_HOURS,
    ReportStatus,
    newsletter_text_ok,
    parse_recommendations,
    recommendation_response_schema,
)

jsonschema = pytest.importorskip("jsonschema", reason="dev dependency jsonschema is not installed")

API = Path(__file__).parents[2] / "api"
STAMP = "2026-09-28T13:30:00Z"
WINDOW = {"computed_at": STAMP, "window_start": "2026-09-27T13:30:00Z", "window_end": STAMP}


def load(name: str) -> dict[str, Any]:
    return json.loads((API / name).read_text())


SUMMARY = load("summary-v1.schema.json")
RECOMMENDATION = load("recommendation-v1.schema.json")
TASKS = RECOMMENDATION["properties"]["tasks"]
TASK = TASKS["items"]
# The Gemini output the Worker accepts is exactly the tasks array it serves.
MODEL_OUTPUT = {"$schema": RECOMMENDATION["$schema"], **TASKS}


def errors(schema: dict[str, Any], instance: Any) -> list[str]:
    return [error.message for error in jsonschema.Draft202012Validator(schema).iter_errors(instance)]


def conditional(schema: dict[str, Any], field: str, value: Any) -> dict[str, Any]:
    """The ``then`` branch of the allOf rule ``if <field> == <value>``."""
    return next(rule["then"] for rule in schema["allOf"] if rule["if"]["properties"].get(field) == {"const": value})


def summary(**fields: Any) -> dict[str, Any]:
    return {
        "summary": "Important\n- 报税截止",
        "task_count": 4,
        "time_window_hours": 24,
        "status": "ok",
        "model": "gemini-3.8-flash",
        **WINDOW,
        **fields,
    }


def recommendation(**fields: Any) -> dict[str, Any]:
    tasks = [{"rank": 1, "title": "报税截止", "reason": "今天必须提交"}]
    return {
        "tasks": tasks,
        "model": "gemini-3.8-flash",
        "task_count": 4,
        "status": "ok",
        "top_n": 10,
        **WINDOW,
        **fields,
    }


@pytest.mark.parametrize("schema", [SUMMARY, RECOMMENDATION], ids=["summary", "recommendation"])
def test_schema_is_valid_draft_2020_12(schema):
    jsonschema.Draft202012Validator.check_schema(schema)


def test_constants_match_core():
    assert SUMMARY["properties"]["time_window_hours"]["const"] == WINDOW_HOURS
    assert conditional(SUMMARY, "status", "empty_window")["properties"]["summary"]["const"] == EMPTY_WINDOW_SUMMARY
    assert TASK["properties"]["rank"]["maximum"] == TASKS["maxItems"] == MAX_TOP_N
    assert TASK["properties"]["title"]["maxLength"] == MAX_TITLE_CHARS
    assert TASK["properties"]["reason"]["maxLength"] == MAX_REASON_CHARS
    assert RECOMMENDATION["properties"]["top_n"]["maximum"] == MAX_TOP_N


def test_repeated_rules_stay_identical():
    """The schemas are self-contained, so shared rules are spelled out more than once."""
    stamps = [
        schema["properties"][field]
        for schema in (SUMMARY, RECOMMENDATION)
        for field in ("computed_at", "window_start", "window_end")
    ]
    assert len({(stamp["type"], stamp["format"], stamp["pattern"]) for stamp in stamps}) == 1
    title, reason = TASK["properties"]["title"], TASK["properties"]["reason"]
    assert title["pattern"] == reason["pattern"] == SUMMARY["properties"]["summary"]["pattern"]
    assert title["allOf"] == reason["allOf"] == [{"pattern": r"\S"}]


def test_statuses_cover_the_vocabulary():
    summary_statuses = set(SUMMARY["properties"]["status"]["enum"])
    recommendation_statuses = set(RECOMMENDATION["properties"]["status"]["enum"])
    assert recommendation_statuses == set(ReportStatus)
    # A free-text summary cannot be structurally invalid.
    assert summary_statuses == set(ReportStatus) - {ReportStatus.MODEL_OUTPUT_INVALID}


def test_gemini_response_schema_describes_the_same_items():
    gemini = recommendation_response_schema(MAX_TOP_N)
    assert gemini["maxItems"] == TASKS["maxItems"]
    assert gemini["items"]["required"] == TASK["required"]
    assert list(gemini["items"]["properties"]) == list(TASK["properties"])


@pytest.mark.parametrize(
    "response",
    [
        summary(),
        summary(summary=EMPTY_WINDOW_SUMMARY, task_count=0, status="empty_window", model=""),
        summary(status="stale"),
        summary(summary=EMPTY_WINDOW_SUMMARY, task_count=0, status="stale", model=""),
    ],
    ids=["ok", "empty_window", "stale", "stale_empty"],
)
def test_summary_accepts(response):
    assert errors(SUMMARY, response) == []


@pytest.mark.parametrize(
    "response",
    [
        summary(summary="  \n"),
        summary(summary="a\x07b"),
        summary(summary="x" * 12_001),
        summary(time_window_hours=23),
        summary(task_count=0),
        summary(task_count=True),
        summary(status="empty_window"),
        summary(summary="nothing", task_count=0, status="empty_window"),
        summary(status="model_output_invalid"),
        summary(computed_at="2026-09-28T13:30:00+00:00"),
        summary(extra=1),
        {key: value for key, value in summary().items() if key != "task_count"},
    ],
    ids=[
        "blank",
        "control_char",
        "too_long",
        "window",
        "ok_without_tasks",
        "bool_count",
        "empty_with_tasks",
        "empty_other_text",
        "invalid_status",
        "offset_time",
        "unknown_field",
        "legacy_field_missing",
    ],
)
def test_summary_rejects(response):
    assert errors(SUMMARY, response) != []


@pytest.mark.parametrize(
    "response",
    [
        recommendation(),
        recommendation(tasks=[]),
        recommendation(tasks=[], task_count=0, status="empty_window", model=""),
        recommendation(tasks=[], status="model_output_invalid"),
        recommendation(status="stale", top_n=3),
    ],
    ids=["ok", "none_worth_it", "empty_window", "model_output_invalid", "stale"],
)
def test_recommendation_accepts(response):
    assert errors(RECOMMENDATION, response) == []


@pytest.mark.parametrize(
    "response",
    [
        recommendation(task_count=0),
        recommendation(status="empty_window"),
        recommendation(status="model_output_invalid"),
        recommendation(tasks=[{"rank": 0, "title": "t", "reason": "r"}]),
        recommendation(tasks=[{"rank": 1, "title": " ", "reason": "r"}]),
        recommendation(tasks=[{"rank": 1, "title": "t", "reason": ""}]),
        recommendation(tasks=[{"rank": 1, "title": "t" * 201, "reason": "r"}]),
        recommendation(tasks=[{"rank": 1, "title": "t", "reason": "r", "score": 1}]),
        recommendation(tasks=[{"rank": n, "title": "t", "reason": "r"} for n in range(1, 12)]),
        recommendation(top_n=11),
        {key: value for key, value in recommendation().items() if key != "model"},
    ],
    ids=[
        "tasks_without_count",
        "empty_with_count",
        "invalid_with_tasks",
        "rank_zero",
        "blank_title",
        "blank_reason",
        "long_title",
        "extra_task_field",
        "eleven_tasks",
        "top_n",
        "legacy_field_missing",
    ],
)
def test_recommendation_rejects(response):
    assert errors(RECOMMENDATION, response) != []


def test_prompt_examples_are_valid_model_output():
    examples = re.findall(r"^\[.*?\]$", RECOMMEND_TOP_TASKS, re.MULTILINE | re.DOTALL)
    assert [len(json.loads(example)) for example in examples] == [0, 1]
    for example in examples:
        assert errors(MODEL_OUTPUT, json.loads(example)) == []


CORE_ACCEPTS = [
    [],
    [{"rank": 2, "title": "续签护照", "reason": "下周到期"}, {"rank": 1, "title": "报税", "reason": "今天截止"}],
    [{"rank": 10, "title": "t" * MAX_TITLE_CHARS, "reason": "多行\n原因"}],
    [{"rank": 1, "title": "t", "reason": "r", "ignored": True}],
]
NEWSLETTER_REJECTS = [
    [{"rank": 1, "title": "t", "reason": ""}],
    [{"rank": 1, "title": "t", "reason": " "}],
    [{"rank": 1, "title": "a\x07b", "reason": "r"}],
    [{"rank": 1, "title": "t", "reason": "r" * (MAX_REASON_CHARS + 1)}],
]


@pytest.mark.parametrize("items", CORE_ACCEPTS)
def test_what_core_accepts_validates_as_newsletter_tasks(items):
    parsed = parse_recommendations(json.dumps(items, ensure_ascii=False), MAX_TOP_N)
    assert parsed is not None
    tasks = [{"rank": r.rank, "title": r.title, "reason": r.reason} for r in parsed]
    assert errors(MODEL_OUTPUT, tasks) == []
    assert errors(RECOMMENDATION, recommendation(tasks=tasks)) == []


@pytest.mark.parametrize("items", NEWSLETTER_REJECTS)
def test_what_the_newsletter_rejects_core_rejects_too(items):
    assert errors(MODEL_OUTPUT, items) != []
    assert parse_recommendations(json.dumps(items), MAX_TOP_N) is None


def test_summary_text_rule_matches_the_schema():
    """S5 stores a daily summary only if it passes newsletter_text_ok (task_count > 0 needs non-blank)."""
    assert SUMMARY["properties"]["summary"]["maxLength"] == MAX_SUMMARY_CHARS
    for text in ("报告\n\t- 一项", " ", "a\x07b", "x" * (MAX_SUMMARY_CHARS + 1)):
        schema_ok = errors(SUMMARY, summary(summary=text)) == []
        assert newsletter_text_ok(text, MAX_SUMMARY_CHARS) == schema_ok, repr(text)
