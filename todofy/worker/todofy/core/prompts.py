"""The three Gemini prompts, byte-for-byte from the Go service.

The summary prompts are utils/consts.go @ 6c46ed4; the recommendation prompt is the
owner-approved uncommitted 2026-09-05 revision of that file.

The leading tabs come from indented Go raw strings and are kept on purpose:
tests/unit/golden holds the exact bytes the old service sent.
"""

from collections.abc import Iterable

SUMMARY_EMAIL = (
    "Could you please provide a concise and comprehensive summary of the given "
    "email? The summary should capture the main points and key details of the text while conveying the "
    "author's intended meaning accurately. Please ensure that the summary is well-organized and easy to read, "
    "with clear headings and subheadings to guide the reader through each section. The length of the "
    "summary should be appropriate to capture the main points and key details of the text, without "
    "including unnecessary information or becoming overly long. \n"
    "\t\n"
    '\tIMPORTANT: Please do not write something like "OK, this is my summary". Just start with the summary.\n'
    "\tIMPORTANT: Try to follow markdown formatting as much as possible.\n"
    "\tIMPORTANT: Please use chinese as response language.\n"
    "\tIMPORTANT: Please try to be concise to 1-2 sentences.\n"
    "\tIMPORTANT: Avoid showing # symbol in the summary.\n"
    "\n"
    "\tThe email content you are to summarize is as follows:"
)

SUMMARY_RANGE = (
    "Below is all of emails I received today and summarized "
    "by previous gemini API call. Please rank them in order (ranked by importance you think), summary "
    "to a brief one sentence each item. So I can have a brief overview of the emails at the start of the morning.\n"
    "\n"
    '\tIMPORTANT: Please do not write something like "OK, this is my summary". Just start with the summary.\n'
    "\tIMPORTANT: Try to follow the format that is readable for mac email app (no markdown).\n"
    "\tIMPORTANT: Don't use double quotes for the email subject. Just use plain text.\n"
    '\tIMPORTANT: Please group emails into four categories: "Important", "Urgent", "Normal", "Low Priority". '
    'If you think the email is not important, please put it into "Low Priority" category.\n'
    "\tIMPORTANT: Similar emails should be treated as one email.\n"
    "\n"
    "\tAll the emails previous summarized by gemini API are as follows:"
)

# Go filled four %d verbs; str.format is unusable because the JSON example
# contains braces, so the placeholder is replaced literally.
RECOMMEND_TOP_TASKS = (
    "Below is a list of task summaries I received in the last 24 hours. "
    "Based on these tasks, please pick up to {top_n} distinct tasks that genuinely require my attention today "
    "or in the near future. "
    "For each task, provide a title and a reason.\n"
    "\n"
    "Rank only the selected tasks consecutively from #1, never exceeding #{top_n}.\n"
    "\n"
    "IMPORTANT: You MUST respond with ONLY a valid JSON array, no other text before or after.\n"
    "IMPORTANT: Each element must have exactly these fields:\n"
    '  "rank" (integer 1-{top_n}), "title" (string, one-line), "reason" (string, 1-2 sentences).\n'
    "IMPORTANT: Output at most {top_n} items. Fewer items are correct; return [] when none qualify.\n"
    "  Never fill unused slots, invent an action, or repeat a task to reach the limit.\n"
    "IMPORTANT: Please use Chinese as response language for title and reason.\n"
    "IMPORTANT: Rank by the specific unresolved action, concrete risk if ignored, and time remaining.\n"
    "  Each concise reason should identify what I need to do and the supported risk or deadline.\n"
    "  Do not invent deadlines or imply that already resolved actions remain open.\n"
    "IMPORTANT: Focus on tasks that require ACTION from me, not merely important-sounding topics.\n"
    "  Ignore promotional emails, coupons, marketing offers, expired or time-bound deals,\n"
    "  routine notifications (e.g. charging station check-ins, subscription renewals),\n"
    "  and anything that does not need a concrete action from me.\n"
    "  Think carefully: does this task REALLY need my attention, or is it just noise?\n"
    "  For example, a 30-minute EV charging reservation is routine — skip it.\n"
    "IMPORTANT: A statement being available is not evidence that a payment action is required.\n"
    "  Ordinary bills with confirmed autopay and no unresolved issue must not consume a priority slot.\n"
    "  Autopay must be explicitly supported for that account or bill; never infer that all cards use autopay.\n"
    '  If autopay status is not given, treat it as unknown and explicitly say "自动扣款状态未知"\n'
    "  when relevant to a selected payment task. Unknown autopay alone is not a reason to create a task.\n"
    "IMPORTANT: Never suppress unresolved exceptions just because autopay is confirmed or the topic is routine:\n"
    "  overdue obligations, failed or returned payments, partial payments leaving an amount due,\n"
    "  insufficient funds, suspicious activity or security alerts, changed obligations requiring action,\n"
    "  and actual deadlines requiring a specific unresolved action must remain eligible for priority.\n"
    "  Apply this protection to financial/tax and work-related tasks as well as other consequential tasks.\n"
    "IMPORTANT: MERGE similar or duplicate tasks into ONE entry.\n"
    "  Multiple emails about the same unresolved issue should be combined into a single recommendation,\n"
    "  while distinct risks or actions must not be collapsed merely because they concern the same service.\n"
    "\n"
    "Example output when no task requires action:\n"
    "[]\n"
    "\n"
    "Example output when only one task qualifies, even if the limit is higher:\n"
    '[{"rank":1,"title":"处理扣款失败","reason":"自动扣款已失败，需在邮件明确的截止时间前处理尚未支付的款项。"}]\n'
    "\n"
    "The task summaries from the last 24 hours are as follows:"
)

REPORT_SEPARATOR = "=" * 25 + "\n"

# The morning brief's carryover (docs/gtd-features.md §3): with older still-open tasks in the input, the
# prompt says so and adds one rule. Without carryover the prompt is RECOMMEND_TOP_TASKS byte for byte.
CARRYOVER_EDITS = (
    (
        "Below is a list of task summaries I received in the last 24 hours. ",
        "Below is a list of task summaries I received in the last 24 hours, plus older tasks that are still open. ",
    ),
    (
        "\nExample output when no task requires action:\n",
        '\nIMPORTANT: An item that starts with "[N 天前]" arrived N days ago and its Todoist task is still open.\n'
        "  Its age alone is neither a reason to rank it higher nor a reason to skip it.\n"
        "  Never call it overdue unless its summary states a date that has passed.\n"
        '  When you select such an item, start its "reason" with "（N 天前）" using the same N,\n'
        "  so I can tell it apart from new mail. Never add that prefix to an item from the last 24 hours.\n"
        "\nExample output when no task requires action:\n",
    ),
    (
        "The task summaries from the last 24 hours are as follows:",
        "The task summaries from the last 24 hours, followed by older tasks that are still open, are as follows:",
    ),
)


def recommend_prompt(top_n: int, carryover: bool = False) -> str:
    prompt = RECOMMEND_TOP_TASKS
    if carryover:
        for old, new in CARRYOVER_EDITS:
            assert prompt.count(old) == 1
            prompt = prompt.replace(old, new)
    return prompt.replace("{top_n}", str(top_n))


def report_input(summaries: Iterable[str]) -> str:
    """The daily-report model input: each cached summary fenced by separator lines."""
    return REPORT_SEPARATOR + "".join(summary + "\n" + REPORT_SEPARATOR for summary in summaries)
