"""Every event shape Mail Hero really emits must pass ``parse_mail_event``.

The fixtures live in the monorepo's contracts/mail-received-v1 (see tests/mail_contract.py).
Mail Hero's own test (mail-hero/cloudflare/test/contract-fixtures.test.mjs) rebuilds each one
with ``parseMail`` and ``buildPayload`` on synthetic mail and fails when its builder no longer
produces these exact bytes, so an incompatible builder change reaches this test before it merges.
``legacy/pre_storage_v1`` is frozen output of the builder before storage-v1 (mail-hero 32f6954^):
retries resend frozen bytes, so Todofy keeps accepting it.
"""

import hashlib
import json
from datetime import UTC, datetime

import jsonschema
import pytest

from tests import mail_contract
from todofy.core.contract import (
    MAX_EVENT_BYTES,
    MAX_TEXT_BYTES,
    ContractError,
    MailEvent,
    parse_mail_event,
    utf8_len,
)
from todofy.core.gemini_wire import summary_content
from todofy.core.render import FOOTER_PREFIX, content_notice, render_todo_body, task_title

FIXTURES = mail_contract.fixtures()
NAMES = list(FIXTURES)
RECEIVED = datetime(2026, 9, 28, 8, 0, tzinfo=UTC)
SCHEMA = jsonschema.Draft202012Validator(json.loads(mail_contract.SCHEMA.read_text()))


def event(name: str) -> MailEvent:
    return parse_mail_event(FIXTURES[name].read_bytes())


def test_the_fixture_set_covers_every_shape():
    assert NAMES == [
        "attachments_capacity",
        "attachments_metadata_limit",
        "attachments_stored_and_omitted",
        "body_only_no_subject",
        "canary_event",
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
def test_every_fixture_matches_the_published_schema(name):
    event = json.loads(FIXTURES[name].read_bytes())
    errors = [f"{list(error.absolute_path)}: {error.message}" for error in SCHEMA.iter_errors(event)]
    assert errors == []


def test_only_the_canary_fixture_carries_the_canary_marker():
    # contracts/ops-v1: consumers must not cause external side effects for these events.
    marked = sorted(name for name, path in FIXTURES.items() if "canary" in json.loads(path.read_bytes()))
    assert marked == ["canary_event"]
    assert json.loads(FIXTURES["canary_event"].read_bytes())["canary"] == {"run_id": "canary-2026-09-28"}


UNREADABLE_CANARIES = [{}, {"run_id": ""}, {"run_id": "canary 1"}, {"run_id": 7}, "canary-1", None]


@pytest.mark.parametrize("canary", UNREADABLE_CANARIES)
def test_the_schema_rejects_an_unreadable_canary_marker(canary):
    document = json.loads(FIXTURES["canary_event"].read_bytes()) | {"canary": canary}
    assert list(SCHEMA.iter_errors(document))


def test_the_parser_reads_the_canary_marker_and_only_there():
    assert event("canary_event").canary_run_id == "canary-2026-09-28"
    assert [name for name in NAMES if event(name).canary_run_id is not None] == ["canary_event"]
    # The schema lets Mail Hero add fields to the marker later.
    document = json.loads(FIXTURES["canary_event"].read_bytes())
    document["canary"]["attempt"] = 2
    assert parse_mail_event(json.dumps(document).encode()).canary_run_id == "canary-2026-09-28"


@pytest.mark.parametrize("canary", [*UNREADABLE_CANARIES, {"run_id": "canary-1\n"}, {"run_id": "x" * 65}])
def test_an_unreadable_canary_marker_is_rejected_not_treated_as_mail(canary):
    """An event that says it is a canary but cannot say which must never become a Todoist task."""
    document = json.loads(FIXTURES["canary_event"].read_bytes()) | {"canary": canary}
    with pytest.raises(ContractError) as error:
        parse_mail_event(json.dumps(document).encode())
    assert error.value.reason == "canary"


# Frozen bytes: retries resend them, so they are never edited. Mail Hero's contract-fixtures.test.mjs
# pins the same hashes; either side alone fails CI when a legacy file changes.
LEGACY_SHA256 = {"pre_storage_v1.json": "9618c81d70e7275c8f324f76cb8989b58e14dd6d1f211fbe61f9dbe9d1b8b48f"}


def test_only_legacy_fixtures_are_frozen_byte_for_byte():
    legacy = mail_contract.CONTRACT / "fixtures" / "legacy"
    digests = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in legacy.glob("*.json")}
    assert digests == LEGACY_SHA256


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
    raw = FIXTURES["max_size"].read_bytes()
    assert 1_000_000 < len(raw) <= MAX_EVENT_BYTES
    assert utf8_len(parse_mail_event(raw).text) == MAX_TEXT_BYTES


def test_extended_year_sent_at_is_accepted():
    """Mail Hero writes ``new Date(header).toISOString()``: a Date header in year 10000
    becomes ``+010000-01-01T00:00:00.000Z``. Python cannot represent it, so the event
    must be accepted with no send time and the task falls back to ``received_at``."""
    parsed = event("sent_at_extended_year")
    assert parsed.sent_at is None
    assert "**DATE: 2026-09-28T08:00:00Z**" in render_todo_body(parsed, "s")
