import json

import pytest

from todofy.core.report_schema import (
    DEFAULT_TOP_N,
    EMPTY_WINDOW_SUMMARY,
    MAX_TITLE_CHARS,
    WINDOW_HOURS,
    Recommendation,
    parse_recommendations,
    parse_top_n,
    recommendation_response_schema,
)


def items(*ranks: int) -> str:
    return json.dumps([{"rank": r, "title": f"任务{r}", "reason": "原因"} for r in ranks], ensure_ascii=False)


def test_window_and_empty_window_sentence_match_go(golden):
    """Go: handle_recommendation_test.go:48 TestTimeDurationToRecommendation and handle_summary.go:41."""
    assert WINDOW_HOURS == 24
    assert EMPTY_WINDOW_SUMMARY.encode() == golden.bytes("summary_empty_window.txt")


@pytest.mark.parametrize(("value", "top_n"), [(None, 3), ("", 3), ("1", 1), ("10", 10), ("+4", 4), ("05", 5)])
def test_top_n_accepts_what_go_accepted(value, top_n):
    assert parse_top_n(value) == top_n
    assert DEFAULT_TOP_N == 3


@pytest.mark.parametrize("value", ["0", "11", "-1", "abc", " 3", "3.0", "1_0", "３"])
def test_top_n_rejects_out_of_range_or_malformed(value):
    with pytest.raises(ValueError):
        parse_top_n(value)


def test_fewer_items_are_valid_and_never_padded():
    """Go: utils/recommendation_prompt_test.go:16-91 (may return [], no padding)."""
    assert parse_recommendations("[]", 5) == []
    assert parse_recommendations(items(2, 1), 5) == [
        Recommendation(1, "任务1", "原因"),
        Recommendation(2, "任务2", "原因"),
    ]


def test_code_fences_are_stripped_like_go():
    assert parse_recommendations(f"```json\n{items(1)}\n```", 3) == [Recommendation(1, "任务1", "原因")]
    assert parse_recommendations(f"  ```\n{items(1)}```  ", 3) == [Recommendation(1, "任务1", "原因")]


@pytest.mark.parametrize(
    "output",
    [
        "not json",
        '{"rank":1,"title":"t","reason":"r"}',
        items(1, 2, 3, 4),
        items(1, 1),
        items(0),
        items(4),
        '[{"rank":true,"title":"t","reason":"r"}]',
        '[{"rank":1.0,"title":"t","reason":"r"}]',
        '[{"rank":1,"title":"  ","reason":"r"}]',
        '[{"rank":1,"title":"t"}]',
        '[{"rank":1,"title":"t","reason":null}]',
        json.dumps([{"rank": 1, "title": "x" * (MAX_TITLE_CHARS + 1), "reason": "r"}]),
        "[1]",
        "[" * 100_000,
    ],
)
def test_invalid_model_output_is_rejected(output):
    """Go passed unparsable output through as a fake task; now it is model_output_invalid."""
    assert parse_recommendations(output, 3) is None


def test_response_schema_caps_items():
    schema = recommendation_response_schema(4)
    assert schema["maxItems"] == 4
    assert schema["items"]["required"] == ["rank", "title", "reason"]
