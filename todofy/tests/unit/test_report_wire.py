"""recommendation-v1 and summary-v1 on the wire: the exact bytes todofy-core stores and serves for fixed synthetic
reports (tests/unit/report_cases.py).

The newsletter reads these bytes (``json.dumps(report, ensure_ascii=False)`` is both the D1 payload_json and the
200 body of /api/summary and /api/recommendation), so the reports' move onto the generated
proto/todofy/report/v1 messages must not change one of them. golden/reports-v1.json is what the code before that
move wrote for each case. ``UPDATE_GOLDEN=1 uv run pytest tests/unit/test_report_wire.py`` rewrites it; only for an
intended change of the contract, never to make a refactor pass.

Each report also reads back strictly with the codec and writes the same bytes, and a report that breaks the
contract is refused before it could be stored.
"""

import dataclasses
import json
import os
from pathlib import Path
from typing import Any

import pytest
from ziyixi_proto.todofy.report.v1 import report_pb as pb
from ziyixi_proto.wire_json import WireJsonError, format_matches, from_wire, to_wire

from tests.unit.report_cases import CASES, STAMPS, newsletter_text_ok
from todofy.core.report_schema import (
    EMPTY_WINDOW_SUMMARY,
    Recommendation,
    ReportStatus,
    recommendation_from_answer,
    recommendation_report,
    summary_report,
)

GOLDEN = Path(__file__).parent / "golden" / "reports-v1.json"


def build(kind: str, case: dict[str, Any]) -> dict[str, Any]:
    if kind == "summary":
        return summary_report(case["text"], case["count"], case["status"], case["model"], case["stamps"])
    if kind == "recommendation":
        tasks = [Recommendation(t["rank"], t["title"], t["reason"]) for t in case["tasks"]]
        return recommendation_report(
            tasks, case["count"], case["status"], case["model"], case["top_n"], STAMPS, case["counts"]
        )
    return recommendation_from_answer(case["text"], case["count"], case["model"], case["top_n"], STAMPS, case["counts"])


def written() -> dict[str, str]:
    return {name: json.dumps(build(kind, case), ensure_ascii=False) for name, kind, case in CASES}


if os.environ.get("UPDATE_GOLDEN") == "1":
    GOLDEN.write_text(json.dumps(written(), indent=2, ensure_ascii=False) + "\n")


def test_every_report_keeps_its_bytes():
    golden = json.loads(GOLDEN.read_text())
    assert list(golden) == [name for name, _, _ in CASES]
    for name, text in written().items():
        assert text == golden[name], name


@pytest.mark.parametrize(("name", "kind", "case"), CASES, ids=[name for name, _, _ in CASES])
def test_a_report_reads_back_strictly_and_writes_the_same_bytes(name, kind, case):
    text = json.dumps(build(kind, case), ensure_ascii=False)
    cls = pb.SummaryReport if kind == "summary" else pb.RecommendationReport
    read = from_wire(cls, json.loads(text), strict=True)
    assert read.unrecognized == []
    assert json.dumps(to_wire(read.message), ensure_ascii=False) == text


SUMMARY = pb.SummaryReport(
    summary="报告",
    task_count=1,
    time_window_hours=24,
    status=pb.ReportStatus.OK,
    model="m",
    **STAMPS,
)
TASK = pb.RecommendedTask(rank=1, title="t", reason="r")
RECOMMENDATION = pb.RecommendationReport(
    tasks=(TASK,), model="m", task_count=1, status=pb.ReportStatus.OK, top_n=3, **STAMPS
)


@pytest.mark.parametrize(
    ("message", "error"),
    [
        (dataclasses.replace(SUMMARY, summary=" \n　"), "summary: does not match SummaryText"),
        (dataclasses.replace(SUMMARY, summary="a\x07b"), "summary: does not match SummaryText"),
        (dataclasses.replace(SUMMARY, task_count=0), "task_count: below the minimum"),
        (dataclasses.replace(SUMMARY, status=pb.ReportStatus.EMPTY_WINDOW), "summary: not an allowed value"),
        (dataclasses.replace(SUMMARY, status=pb.ReportStatus.MODEL_OUTPUT_INVALID), "status: not an allowed value"),
        (dataclasses.replace(SUMMARY, status=pb.ReportStatus.UNSPECIFIED), "status: required"),
        (dataclasses.replace(SUMMARY, time_window_hours=23), "time_window_hours: below the minimum"),
        (dataclasses.replace(SUMMARY, computed_at="2026-09-28T13:30:00.000Z"), "computed_at: does not match Time"),
        (
            dataclasses.replace(RECOMMENDATION, status=pb.ReportStatus.EMPTY_WINDOW, task_count=0),
            "tasks: not empty when the discriminator is empty_window",
        ),
        (
            dataclasses.replace(RECOMMENDATION, status=pb.ReportStatus.MODEL_OUTPUT_INVALID),
            "tasks: not empty when the discriminator is model_output_invalid",
        ),
        (dataclasses.replace(RECOMMENDATION, task_count=0, tasks=()), "task_count: below the minimum"),
        (
            dataclasses.replace(RECOMMENDATION, status=pb.ReportStatus.STALE, task_count=0),
            "task_count: below the minimum",
        ),
        (
            dataclasses.replace(RECOMMENDATION, tasks=(dataclasses.replace(TASK, rank=11),)),
            "tasks[0].rank: above the maximum",
        ),
        (
            dataclasses.replace(RECOMMENDATION, tasks=(dataclasses.replace(TASK, title=" "),)),
            "tasks[0].title: does not match Title",
        ),
        (dataclasses.replace(RECOMMENDATION, tasks=(TASK,) * 11), "tasks: more than 10 items"),
        (dataclasses.replace(RECOMMENDATION, top_n=0), "top_n: below the minimum"),
        (dataclasses.replace(RECOMMENDATION, new_count=-1), "new_count: below the minimum"),
    ],
)
def test_a_report_that_breaks_the_contract_is_never_written(message, error):
    with pytest.raises(WireJsonError) as caught:
        to_wire(message)
    assert str(caught.value) == error


def test_the_builders_refuse_what_the_newsletter_would():
    with pytest.raises(WireJsonError):
        summary_report("", 3, ReportStatus.OK, "m", STAMPS)
    with pytest.raises(WireJsonError):
        summary_report("nothing", 0, ReportStatus.EMPTY_WINDOW, "", STAMPS)
    with pytest.raises(ValueError):
        summary_report(EMPTY_WINDOW_SUMMARY, 0, "partial", "", STAMPS)


def test_an_answer_too_large_for_the_newsletter_is_model_output_invalid():
    answer = json.dumps([{"rank": 1, "title": "t", "reason": "r"}])
    counts = {"new_count": 1, "carryover_count": 0}
    report = recommendation_from_answer(answer, 1, "m", 3, STAMPS, counts, max_bytes=100)
    assert (report["status"], report["tasks"], report["new_count"]) == ("model_output_invalid", [], 1)
    assert recommendation_from_answer(answer, 1, "m", 3, STAMPS, counts)["status"] == "ok"


def test_the_newsletters_text_rule_is_the_contracts_format():
    """newsletter_text_ok (the newsletter's _decode, as it writes it) and the formats every report is written with
    agree: on every character below U+3100 (controls, Latin, the Unicode spaces) and a spread of the rest, alone and
    in text, and at each format's length bound."""
    codes = [*range(0x3100), *range(0x3100, 0x110000, 97), 0xFEFF, 0x10FFFF]
    for fmt in (pb.FORMATS["Title"], pb.FORMATS["Reason"], pb.FORMATS["SummaryText"]):
        for code in codes:
            if 0xD800 <= code <= 0xDFFF:
                continue
            for text in (chr(code), f"a{chr(code)}", f" {chr(code)} "):
                assert newsletter_text_ok(text, fmt.max_length) == format_matches(fmt, text), (fmt.name, hex(code))
        for text in ("x" * fmt.max_length, "x" * (fmt.max_length + 1), "题" * fmt.max_length):
            assert newsletter_text_ok(text, fmt.max_length) == format_matches(fmt, text), fmt.name
