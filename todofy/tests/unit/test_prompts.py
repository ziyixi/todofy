import pytest

from todofy.core import prompts
from todofy.core.report_schema import Recommendation, parse_recommendations


def test_summary_prompts_are_byte_identical_to_go(golden):
    assert prompts.SUMMARY_EMAIL.encode() == golden.bytes("prompt_summary_email.txt")
    assert prompts.SUMMARY_RANGE.encode() == golden.bytes("prompt_summary_range.txt")


@pytest.mark.parametrize("top_n", [1, 3, 10])
def test_recommend_prompt_matches_go_sprintf(golden, top_n):
    """Go: fmt.Sprintf(DefaultPromptToRecommendTopTasks, n, n, n, n) in handle_recommendation.go."""
    assert prompts.recommend_prompt(top_n).encode() == golden.bytes(f"prompt_recommend_top{top_n}.txt")


@pytest.mark.parametrize("top_n", [1, 3, 10])
def test_recommend_prompt_names_n_in_all_four_places(top_n):
    """Go: utils/recommendation_prompt_test.go TestRecommendationPromptFormatting."""
    assert prompts.RECOMMEND_TOP_TASKS.count("{top_n}") == 4
    assert "%" not in prompts.RECOMMEND_TOP_TASKS
    rendered = prompts.recommend_prompt(top_n)
    assert "{top_n}" not in rendered
    for fragment in (
        f"pick up to {top_n} distinct tasks",
        f"never exceeding #{top_n}",
        f'"rank" (integer 1-{top_n})',
        f"Output at most {top_n} items",
    ):
        assert fragment in rendered


@pytest.mark.parametrize(
    "instruction",
    [
        "Fewer items are correct; return [] when none qualify",
        "Never fill unused slots, invent an action, or repeat a task to reach the limit",
        "Rank only the selected tasks consecutively from #1",
        "Example output when no task requires action:\n[]",
        "Example output when only one task qualifies, even if the limit is higher",
        "ONLY a valid JSON array",
        '"title" (string, one-line), "reason" (string, 1-2 sentences)',
        "Chinese as response language for title and reason",
    ],
)
def test_recommend_prompt_allows_fewer_or_zero_tasks(instruction):
    """Go: utils/recommendation_prompt_test.go TestRecommendationPromptAllowsFewerOrZeroTasks."""
    assert instruction in prompts.RECOMMEND_TOP_TASKS


@pytest.mark.parametrize("forbidden", ["exactly {top_n}", "re-emphasize the same task"])
def test_recommend_prompt_drops_padding_instructions(forbidden):
    assert forbidden not in prompts.RECOMMEND_TOP_TASKS


@pytest.mark.parametrize(
    "instruction",
    [
        "specific unresolved action, concrete risk if ignored, and time remaining",
        "Do not invent deadlines or imply that already resolved actions remain open",
        "A statement being available is not evidence that a payment action is required",
        "Ordinary bills with confirmed autopay and no unresolved issue must not consume a priority slot",
        "Autopay must be explicitly supported for that account or bill",
        "never infer that all cards use autopay",
        "If autopay status is not given, treat it as unknown",
        "自动扣款状态未知",
        "Unknown autopay alone is not a reason to create a task",
    ],
)
def test_recommend_prompt_requires_evidence_for_payment_action(instruction):
    """Go: utils/recommendation_prompt_test.go TestRecommendationPromptRequiresEvidenceForPaymentAction."""
    assert instruction in prompts.RECOMMEND_TOP_TASKS


@pytest.mark.parametrize(
    "instruction",
    [
        "Never suppress unresolved exceptions just because autopay is confirmed or the topic is routine",
        "overdue obligations",
        "failed or returned payments",
        "partial payments leaving an amount due",
        "insufficient funds",
        "suspicious activity or security alerts",
        "changed obligations requiring action",
        "actual deadlines requiring a specific unresolved action must remain eligible for priority",
        "distinct risks or actions must not be collapsed merely because they concern the same service",
    ],
)
def test_recommend_prompt_preserves_actionable_exceptions(instruction):
    """Go: utils/recommendation_prompt_test.go TestRecommendationPromptPreservesActionableExceptions."""
    assert instruction in prompts.RECOMMEND_TOP_TASKS


@pytest.mark.parametrize(
    ("model_output", "expected"),
    [
        ("[]", []),
        (
            '[{"rank":1,"title":"处理扣款失败","reason":"仍有未付金额。"}]',
            [Recommendation(1, "处理扣款失败", "仍有未付金额。")],
        ),
        (
            '[{"rank":1,"title":"检查安全警报","reason":"发现可疑活动。"},'
            '{"rank":2,"title":"处理扣款失败","reason":"仍有未付金额。"}]',
            [
                Recommendation(1, "检查安全警报", "发现可疑活动。"),
                Recommendation(2, "处理扣款失败", "仍有未付金额。"),
            ],
        ),
    ],
    ids=["zero", "one", "two"],
)
def test_recommendations_below_the_limit_are_not_padded(model_output, expected):
    """Go: handle_recommendation_test.go:48 TestHandleRecommendation_DoesNotPadBelowLimit (top=5)."""
    prompt = prompts.recommend_prompt(5)
    assert "Output at most 5 items" in prompt
    assert parse_recommendations(model_output, 5) == expected


def test_go_raw_string_indentation_is_kept():
    assert "overly long. \n\t\n\tIMPORTANT: Please do not write" in prompts.SUMMARY_EMAIL
    assert prompts.SUMMARY_EMAIL.endswith("\n\n\tThe email content you are to summarize is as follows:")
    assert prompts.SUMMARY_RANGE.endswith("\n\n\tAll the emails previous summarized by gemini API are as follows:")


def test_report_input_matches_go_handlers(golden):
    """Go: handle_summary.go and handle_recommendation.go build the same separator-fenced input."""
    summaries = ["第一条合成摘要", "Second synthetic summary"]
    assert prompts.report_input(summaries).encode() == golden.bytes("report_input.txt")
    assert prompts.report_input([]) == prompts.REPORT_SEPARATOR
