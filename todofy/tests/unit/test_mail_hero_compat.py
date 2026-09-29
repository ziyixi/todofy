"""Every event shape Mail Hero really emits must pass ``parse_mail_event``.

tests/fixtures/mail_hero holds exact webhook bytes produced once by Mail Hero's own
code at mail-hero 5d2b625: ``parseMail`` on synthetic .eml files, then
``buildPayload`` as ``createDelivery`` calls it (``pre_storage_v1`` uses the builder
from before storage-v1, mail-hero 32f6954^). The throwaway node script that made
them is not kept, so Todofy never depends on Mail Hero's source.
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from todofy.core.contract import MAX_EVENT_BYTES, MAX_TEXT_BYTES, MailEvent, parse_mail_event, utf8_len
from todofy.core.gemini_wire import summary_content
from todofy.core.render import FOOTER_PREFIX, content_notice, render_todo_body, task_title

FIXTURES = Path(__file__).parents[1] / "fixtures" / "mail_hero"
NAMES = sorted(path.stem for path in FIXTURES.glob("*.json"))
RECEIVED = datetime(2026, 9, 28, 8, 0, tzinfo=UTC)


def event(name: str) -> MailEvent:
    return parse_mail_event((FIXTURES / f"{name}.json").read_bytes())


def test_the_fixture_set_covers_every_shape():
    assert NAMES == [
        "attachments_capacity",
        "attachments_metadata_limit",
        "attachments_stored_and_omitted",
        "body_only_no_subject",
        "chinese",
        "html_only",
        "max_size",
        "needs_review_attached_message",
        "needs_review_no_readable_body",
        "no_date_no_message_id",
        "plain_text",
        "pre_storage_v1",
        "sent_at_extended_year",
        "synthetic_test_event",
        "truncated_ui_and_webhook",
        "truncated_webhook",
    ]


@pytest.mark.parametrize("name", NAMES)
def test_every_mail_hero_shape_is_accepted_and_renders(name):
    parsed = event(name)
    assert parsed.received_at == RECEIVED
    body = render_todo_body(parsed, "摘要")
    assert body.endswith(f"\n\n{FOOTER_PREFIX}{parsed.event_id}")
    assert task_title(parsed).strip()
    if not parsed.unreadable:
        assert summary_content(parsed).strip()


def test_optional_fields_absent_or_null_as_mail_hero_sends_them():
    bare = event("no_date_no_message_id")
    assert (bare.sent_at, bare.rfc_message_id, bare.to_addresses) == (None, None, ())
    assert bare.from_addresses[0].name == ""
    assert "**DATE: 2026-09-28T08:00:00Z**" in render_todo_body(bare, "s")

    old = event("pre_storage_v1")
    assert (old.text_truncated, old.original_text_bytes, old.content_policy_version, old.warnings) == (
        False,
        None,
        "",
        (),
    )

    synthetic = event("synthetic_test_event")
    assert (synthetic.subject, synthetic.to_addresses, synthetic.sent_at) == ("Mail Hero webhook test", (), None)


def test_body_only_mail_gets_the_placeholder_title():
    assert task_title(event("body_only_no_subject")) == "(No subject)"


def test_chinese_and_html_derived_text_arrive_verbatim():
    chinese = event("chinese")
    assert chinese.subject == "季度预缴税提醒：10 月 15 日截止"
    assert chinese.from_addresses[0].name == "张三"
    assert "#重要" in chinese.text
    html = event("html_only")
    assert html.text == "Invoice\nAmount due: $42 & fees.\nPay"
    assert not html.html_omitted


@pytest.mark.parametrize(
    ("name", "original"), [("truncated_webhook", 300_027), ("truncated_ui_and_webhook", 1_200_000)]
)
def test_truncated_bodies_carry_a_consistent_policy(name, original):
    parsed = event(name)
    assert parsed.text_truncated and parsed.original_text_bytes == original
    assert utf8_len(parsed.text) <= MAX_TEXT_BYTES
    assert "text_truncated" in parsed.warnings
    assert content_notice(parsed).startswith("正文不完整：")


@pytest.mark.parametrize("name", ["needs_review_attached_message", "needs_review_no_readable_body"])
def test_review_flagged_mail_is_accepted_but_never_summarised(name):
    parsed = event(name)
    assert parsed.needs_review and parsed.unreadable


def test_attachment_metadata_as_mail_hero_reports_it():
    mixed = event("attachments_stored_and_omitted").attachments
    assert [(a.filename, a.storage_status, a.omitted_reason) for a in mixed] == [
        ("report.pdf", "stored", None),
        ("huge.bin", "omitted", "size_limit"),
        ("logo.png", "omitted", "inline_image"),
        ("part1.zip", "stored", None),
        ("part2.zip", "stored", None),
        ("part3.zip", "omitted", "message_size_limit"),
    ]
    assert event("attachments_capacity").attachments[0].omitted_reason == "capacity"
    capped = event("attachments_metadata_limit")
    assert (len(capped.attachments), capped.attachments_omitted_count) == (100, 5)


def test_the_largest_event_fits_the_webhook_limit():
    raw = (FIXTURES / "max_size.json").read_bytes()
    assert 1_000_000 < len(raw) <= MAX_EVENT_BYTES
    assert utf8_len(parse_mail_event(raw).text) == MAX_TEXT_BYTES


def test_extended_year_sent_at_is_accepted():
    """Mail Hero writes ``new Date(header).toISOString()``: a Date header in year 10000
    becomes ``+010000-01-01T00:00:00.000Z``. Python cannot represent it, so the event
    must be accepted with no send time and the task falls back to ``received_at``."""
    parsed = event("sent_at_extended_year")
    assert parsed.sent_at is None
    assert "**DATE: 2026-09-28T08:00:00Z**" in render_todo_body(parsed, "s")
