import json
from datetime import datetime

import pytest

from todofy.core.contract import parse_mail_event
from todofy.core.render import clean_summary, content_notice, rfc3339


def event_from(payload):
    return parse_mail_event(json.dumps(payload, ensure_ascii=False).encode())


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


def test_truncation_notice_reaches_the_summary(payload):
    """Go: mail_content_policy_test.go:63 TestMailTruncatedBodyNoticeSurvivesSummaryAndTask."""
    payload["message"] |= {"text": "中文🙂", "text_truncated": True, "original_text_bytes": 300_000}
    event = event_from(payload)
    notice = "正文不完整：原文 300000 bytes，仅收到前 10 bytes，摘要可能遗漏尾部内容。"
    assert content_notice(event) == notice
    summary = clean_summary("Synthetic summary", event)
    assert summary == f"{notice}\n\nSynthetic summary"


def test_date_prefers_sent_at_and_is_utc_whole_seconds():
    assert rfc3339(datetime.fromisoformat("2026-09-23T08:30:15.987-07:00")) == "2026-09-23T15:30:15Z"
    assert rfc3339(datetime.fromisoformat("0999-01-02T03:04:05Z")) == "0999-01-02T03:04:05Z"
