"""Current business prompts and their examples agree with the existing output readers."""

import json
import re

import pytest

from todofy.core import prompts
from todofy.core.contract import parse_mail_event
from todofy.core.mailbox import brief_of
from todofy.core.render import clean_summary
from todofy.core.report_schema import fit_summary, parse_recommendations, recommendation_response_schema


def example_outputs(prompt: str) -> list[str]:
    return re.findall(r"^输出：\n(.+?)(?=\n\n|\Z)", prompt, re.MULTILINE | re.DOTALL)


def test_summary_prompts_are_pinned(golden):
    assert prompts.SUMMARY_EMAIL.encode() == golden.bytes("prompt_summary_email.txt")
    assert prompts.SUMMARY_RANGE.encode() == golden.bytes("prompt_summary_range.txt")


@pytest.mark.parametrize("top_n", [1, 3, 10])
def test_recommend_prompt_is_pinned(golden, top_n):
    assert prompts.recommend_prompt(top_n).encode() == golden.bytes(f"prompt_recommend_top{top_n}.txt")


def test_carryover_prompt_is_pinned(golden):
    assert prompts.recommend_prompt(10, carryover=True).encode() == golden.bytes("prompt_recommend_top10_carryover.txt")


def test_email_examples_survive_cleanup_and_supply_the_mailbox_brief(payload):
    event = parse_mail_event(json.dumps(payload, ensure_ascii=False).encode())
    examples = example_outputs(prompts.SUMMARY_EMAIL)
    assert len(examples) == 4
    for example in examples:
        first, *rest = example.splitlines()
        assert len(first) <= 40
        assert len(rest) <= 1
        assert 1 <= len(re.findall(r"[。！？]", example)) <= 2
        assert not any(mark in example for mark in ("#", "```", "**", "{", "}"))
        assert clean_summary(example, event) == example
        assert brief_of(example) == first


def test_range_examples_are_plain_text_in_the_four_categories():
    examples = example_outputs(prompts.SUMMARY_RANGE)
    assert len(examples) == 2
    categories = ["Urgent", "Important", "Normal", "Low Priority"]
    for example in examples:
        assert fit_summary(example) == example
        assert [line for line in example.splitlines() if line in categories] == categories
        for line in example.splitlines():
            assert line in categories or line == "无。" or re.match(r"[一二三四五六七八九十]+、.+[。！？]$", line)
        assert not any(mark in example for mark in ("#", "```", "**", '"', "{", "}"))


@pytest.mark.parametrize("top_n", [1, 3, 5, 10])
def test_recommendation_examples_parse_for_each_supported_limit(top_n):
    """Even the smallest limit must accept every few-shot, including the carried pick."""
    prompt = prompts.recommend_prompt(top_n, carryover=True)
    assert f"本次最多选择 {top_n} 项。" in prompt
    assert "{top_n}" not in prompt
    examples = example_outputs(prompt)
    assert len(examples) == 7
    assert examples[0] == "[]"
    for example in examples:
        tasks = parse_recommendations(example, top_n)
        assert tasks is not None
        assert [task.rank for task in tasks] == list(range(1, len(tasks) + 1))
        assert all(set(item) == {"rank", "title", "reason"} for item in json.loads(example))
        assert all("\n" not in task.title for task in tasks)


def test_recommendation_examples_match_the_structured_output_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = recommendation_response_schema(1)
    for example in example_outputs(prompts.recommend_prompt(1, carryover=True)):
        jsonschema.validate(json.loads(example), schema)


def test_only_the_carried_example_uses_its_input_age():
    plain = prompts.recommend_prompt(3)
    carried = prompts.recommend_prompt(3, carryover=True)
    assert carried.startswith(prompts.RECOMMEND_TOP_TASKS)
    new_examples = example_outputs(plain)
    carried_examples = example_outputs(carried)
    assert carried_examples[: len(new_examples)] == new_examples
    old_example, resolved_example = carried_examples[len(new_examples) :]
    assert parse_recommendations(resolved_example, 3) == []
    assert all(
        not task.reason.startswith("（") for example in new_examples for task in parse_recommendations(example, 3)
    )
    (task,) = parse_recommendations(old_example, 3)
    assert "[6 天前]" in carried
    assert task.reason.startswith("（6 天前）")
    assert "逾期" not in task.title + task.reason
    assert "会议日期和回复期限尚未确定" in task.reason


def test_report_input_keeps_the_existing_separator_bytes(golden):
    summaries = ["第一条合成摘要", "Second synthetic summary"]
    assert prompts.report_input(summaries).encode() == golden.bytes("report_input.txt")
    assert prompts.report_input([]) == prompts.REPORT_SEPARATOR


def test_current_paid_update_resolves_the_appended_older_failure():
    prompt = prompts.recommend_prompt(1, carryover=True)
    match = re.search(r"示例七：[^\n]*\n输入：\n(.+?)\n输出：\n(\[\])", prompt, re.DOTALL)
    assert match is not None
    current, carried = match[1].splitlines()
    assert current.startswith("10月28日确认") and "已缴清" in current
    assert carried.startswith("[3 天前] 10月25日") and "扣款失败" in carried
    assert parse_recommendations(match[2], 1) == []
