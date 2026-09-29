import pytest

from todofy.core import prompts


def test_summary_prompts_are_byte_identical_to_go(golden):
    assert prompts.SUMMARY_EMAIL.encode() == golden.bytes("prompt_summary_email.txt")
    assert prompts.SUMMARY_RANGE.encode() == golden.bytes("prompt_summary_range.txt")


@pytest.mark.parametrize("top_n", [1, 3, 10])
def test_recommend_prompt_matches_go_sprintf(golden, top_n):
    """Go: fmt.Sprintf(DefaultPromptToRecommendTopTasks, n, n, n, n) in handle_recommendation.go."""
    assert prompts.recommend_prompt(top_n).encode() == golden.bytes(f"prompt_recommend_top{top_n}.txt")


def test_recommend_prompt_names_n_in_four_places_and_keeps_json_examples():
    """Go: utils/recommendation_prompt_test.go:16-91 (N in four places) and utils/consts_test.go."""
    assert prompts.RECOMMEND_TOP_TASKS.count("{top_n}") == 4
    rendered = prompts.recommend_prompt(7)
    assert "{top_n}" not in rendered
    for fragment in ("exactly 7 that", "(#7)", "(integer 1-7)", "Output exactly 7 items"):
        assert fragment in rendered
    assert '[{"rank":1,"title":"任务标题","reason":"原因说明"},\n' in rendered


def test_go_raw_string_indentation_is_kept():
    assert "overly long. \n\t\n\tIMPORTANT: Please do not write" in prompts.SUMMARY_EMAIL
    assert prompts.SUMMARY_EMAIL.endswith("\n\n\tThe email content you are to summarize is as follows:")
    assert prompts.SUMMARY_RANGE.endswith("\n\n\tAll the emails previous summarized by gemini API are as follows:")


def test_report_input_matches_go_handlers(golden):
    """Go: handle_summary.go and handle_recommendation.go build the same separator-fenced input."""
    summaries = ["第一条合成摘要", "Second synthetic summary"]
    assert prompts.report_input(summaries).encode() == golden.bytes("report_input.txt")
    assert prompts.report_input([]) == prompts.REPORT_SEPARATOR
