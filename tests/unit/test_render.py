import json
from datetime import datetime

import pytest

from todofy.core.contract import parse_mail_event
from todofy.core.render import (
    FOOTER_PREFIX,
    NO_SUBJECT,
    clean_summary,
    has_footer,
    render_todo_body,
    rfc3339,
    summary_input,
    task_title,
)

CASES = ["ascii", "chinese", "truncated"]


def event_from(payload):
    return parse_mail_event(json.dumps(payload, ensure_ascii=False).encode())


@pytest.mark.parametrize("case", CASES)
def test_todo_body_is_byte_identical_to_go(golden, case):
    """Go: renderMailTodoBody + the truncation notice from summarize() (mail_inbox_worker.go:156-223)."""
    event = parse_mail_event(golden.bytes(f"event_{case}.json"))
    summary = clean_summary(golden.text(f"model_summary_{case}.txt"), event)
    assert render_todo_body(event, summary).encode() == golden.bytes(f"todo_body_{case}.txt")


@pytest.mark.parametrize("case", CASES)
def test_summary_input_is_byte_identical_to_go(golden, case):
    event = parse_mail_event(golden.bytes(f"event_{case}.json"))
    assert summary_input(event).encode() == golden.bytes(f"summary_input_{case}.txt")


def test_body_only_message_gets_nonempty_title_and_footer(payload):
    """Go: mail_inbox_test.go:347 TestMailInboxBodyOnlyMessageGetsNonemptyTodoTitle."""
    payload["message"]["subject"] = "   "
    event = event_from(payload)
    assert task_title(event) == NO_SUBJECT
    body = render_todo_body(event, "Synthetic summary")
    assert body.endswith(f"\n\n{FOOTER_PREFIX}{event.event_id}")
    assert "**SUBJECT:    **" in body  # the archived subject itself is kept


def test_subject_is_the_title_when_present(payload):
    assert task_title(event_from(payload)) == payload["message"]["subject"]


def test_markdown_is_not_html_escaped(payload):
    """Deliberate change (v2 B1): Go's html/template turned these into entities."""
    payload["message"]["subject"] = "A & B <x> 'q' \"d\""
    payload["message"]["from"][0]["address"] = "o'brien@example.org"
    body = render_todo_body(event_from(payload), 'Tom & Jerry <3 "ok"')
    assert "**SUBJECT: A & B <x> 'q' \"d\"**" in body
    assert "**FROM: o'brien@example.org**" in body
    assert 'Tom & Jerry <3 "ok"' in body
    for entity in ("&amp;", "&lt;", "&gt;", "&#39;", "&#34;", "&quot;"):
        assert entity not in body


@pytest.mark.parametrize(
    ("model_output", "expected"),
    [
        ("Reply #urgent today", "Reply today"),
        ("Tags #a #b end", "Tags #b end"),  # non-overlapping, like Go's ReplaceAllString
        ("Line\n#todo\nnext", "Line next"),
        ("Keep#inline and #toolongtag11 and C# code", "Keep#inline and #toolongtag11 and C# code"),
        ("中文　#tag　文本", "中文　#tag　文本"),  # RE2 \s is ASCII-only
    ],
)
def test_hashtag_becomes_a_single_space(payload, model_output, expected):
    """Deliberate change (v2 §5.3): Go wrote '<removed tag>' instead of a space."""
    summary = clean_summary(model_output, event_from(payload))
    assert summary == expected
    assert "<removed tag>" not in summary


def test_truncation_notice_reaches_summary_and_task(payload):
    """Go: mail_content_policy_test.go:63 TestMailTruncatedBodyNoticeSurvivesSummaryAndTask."""
    payload["message"] |= {"text": "中文🙂", "text_truncated": True, "original_text_bytes": 300_000}
    event = event_from(payload)
    notice = "正文不完整：原文 300000 bytes，仅收到前 10 bytes，摘要可能遗漏尾部内容。"
    assert summary_input(event) == f"{notice}\n\n中文🙂"
    summary = clean_summary("Synthetic summary", event)
    assert summary == f"{notice}\n\nSynthetic summary"
    assert notice in render_todo_body(event, summary)


def test_body_falls_back_to_subject_for_model_input(payload):
    payload["message"]["text"] = " \n"
    assert summary_input(event_from(payload)) == payload["message"]["subject"]


def test_date_prefers_sent_at_and_is_utc_whole_seconds():
    assert rfc3339(datetime.fromisoformat("2026-09-23T08:30:15.987-07:00")) == "2026-09-23T15:30:15Z"
    assert rfc3339(datetime.fromisoformat("0999-01-02T03:04:05Z")) == "0999-01-02T03:04:05Z"


def test_footer_matching_is_exact():
    event_id = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"
    assert has_footer(f"body\n\nMail Hero event: {event_id}", event_id)
    assert has_footer(f"Mail Hero event: {event_id}\n(edited)", event_id)
    assert not has_footer(f"Mail Hero event: {event_id}0", event_id)
    assert not has_footer(f"Mail Hero event: {event_id.upper()}", event_id)
    assert not has_footer(f"Mail Hero event:{event_id}", event_id)
