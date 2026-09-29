"""The three Gemini prompts, byte-for-byte from the Go service (utils/consts.go @ 6c46ed4).

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

# Go filled four %d verbs; str.format is unusable because the JSON examples
# contain braces, so the placeholder is replaced literally.
RECOMMEND_TOP_TASKS = (
    "Below is a list of task summaries I received in the last 24 hours. "
    "Based on these tasks, please pick exactly {top_n} that are the most important and require my attention TODAY. "
    "For each task, provide a title and a reason.\n"
    "\n"
    "Rank them from most important (#1) to least important (#{top_n}).\n"
    "\n"
    "IMPORTANT: You MUST respond with ONLY a valid JSON array, no other text before or after.\n"
    "IMPORTANT: Each element must have exactly these fields:\n"
    '  "rank" (integer 1-{top_n}), "title" (string, one-line), "reason" (string, 1-2 sentences).\n'
    "IMPORTANT: Output exactly {top_n} items. If there are fewer tasks, re-emphasize the same task and note it.\n"
    "IMPORTANT: Please use Chinese as response language for title and reason.\n"
    "IMPORTANT: Keep each reason concise.\n"
    "IMPORTANT: Focus on tasks that require ACTION from me today or in the near future.\n"
    "  Ignore promotional emails, coupons, marketing offers, expired or time-bound deals,\n"
    "  routine notifications (e.g. charging station check-ins, subscription renewals),\n"
    "  and anything that does not need a concrete action from me.\n"
    "  Think carefully: does this task REALLY need my attention, or is it just noise?\n"
    "  For example, a 30-minute EV charging reservation is routine — skip it.\n"
    "  Prioritize: security alerts, deadlines, financial/tax documents,\n"
    "  work-related items, and things with real consequences if ignored.\n"
    "IMPORTANT: MERGE similar or duplicate tasks into ONE entry.\n"
    "  Multiple emails about the same topic (e.g. two security alerts from the same\n"
    "  service) should be combined into a single recommendation, not listed separately.\n"
    "\n"
    "Example output format (for 3 items):\n"
    '[{"rank":1,"title":"任务标题","reason":"原因说明"},\n'
    '{"rank":2,"title":"任务标题","reason":"原因说明"},\n'
    '{"rank":3,"title":"任务标题","reason":"原因说明"}]\n'
    "\n"
    "Example output format (for 5 items):\n"
    '[{"rank":1,"title":"任务标题","reason":"原因说明"},\n'
    '{"rank":2,"title":"任务标题","reason":"原因说明"},\n'
    '{"rank":3,"title":"任务标题","reason":"原因说明"},\n'
    '{"rank":4,"title":"任务标题","reason":"原因说明"},\n'
    '{"rank":5,"title":"任务标题","reason":"原因说明"}]\n'
    "\n"
    "The task summaries from the last 24 hours are as follows:"
)

REPORT_SEPARATOR = "=" * 25 + "\n"


def recommend_prompt(top_n: int) -> str:
    return RECOMMEND_TOP_TASKS.replace("{top_n}", str(top_n))


def report_input(summaries: Iterable[str]) -> str:
    """The daily-report model input: each cached summary fenced by separator lines."""
    return REPORT_SEPARATOR + "".join(summary + "\n" + REPORT_SEPARATOR for summary in summaries)
