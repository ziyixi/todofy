import copy
import json
from pathlib import Path

import pytest

from todofy.core import contract
from todofy.core.contract import ContractError, parse_mail_event

SCHEMA = json.loads((Path(__file__).parents[2] / "api" / "mail-received-v1.schema.json").read_text())


def encode(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode()


def with_message(payload, **fields) -> bytes:
    changed = copy.deepcopy(payload)
    changed["message"] |= fields
    return encode(changed)


@pytest.mark.parametrize("case", ["ascii", "chinese", "truncated"])
def test_golden_events_parse(golden, case):
    event = parse_mail_event(golden.bytes(f"event_{case}.json"))
    assert event.event_id.startswith("f8c1e9a0-")


def test_parsed_fields(golden):
    event = parse_mail_event(golden.bytes("event_ascii.json"))
    assert event.from_addresses[0] == contract.Address("sender@example.org", "Sender")
    assert event.to_addresses[0].address == "owner@example.org"
    assert event.sent_at is not None and event.sent_at.utcoffset().total_seconds() == -7 * 3600
    assert event.rfc_message_id is None and event.attachments == ()
    assert (event.text_truncated, event.original_text_bytes, event.warnings) == (False, None, ())


@pytest.mark.parametrize("field", contract.EVENT_FIELDS)
def test_missing_event_field_is_rejected(payload, field):
    """Go: mail_inbox_test.go:282 TestMailInboxRejectsIncompleteContract."""
    del payload[field]
    with pytest.raises(ContractError):
        parse_mail_event(encode(payload))


@pytest.mark.parametrize("field", contract.MESSAGE_FIELDS)
def test_missing_message_field_is_rejected(payload, field):
    """Go: mail_inbox_test.go:282, e.g. a payload without "attachments"."""
    del payload["message"][field]
    with pytest.raises(ContractError):
        parse_mail_event(encode(payload))


def test_content_policy_metadata_compatibility(payload):
    """Go: mail_content_policy_test.go:38 TestMailContentPolicyMetadataCompatibility."""
    valid = {
        "text": "中文🙂",
        "text_truncated": True,
        "original_text_bytes": 300_000,
        "html_omitted": True,
        "attachments_omitted_count": 2,
        "content_policy_version": "storage-v1",
        "attachments": [
            {
                "filename": "large.bin",
                "content_type": "application/octet-stream",
                "size": 3 << 20,
                "storage_status": "omitted",
                "omitted_reason": "size_limit",
            }
        ],
    }
    event = parse_mail_event(with_message(payload, **valid))
    assert event.text_truncated and event.original_text_bytes == 300_000
    assert event.attachments[0].storage_status == "omitted"
    for invalid in (
        {"text_truncated": True},
        {"text": "中文🙂", "text_truncated": True, "original_text_bytes": 10},
        {"text": "中文🙂", "original_text_bytes": 9},
        {"text": "中文🙂", "original_text_bytes": 11},
        {"attachments_omitted_count": -1},
    ):
        with pytest.raises(ContractError):
            parse_mail_event(with_message(payload, **invalid))
    assert parse_mail_event(with_message(payload, text="中文🙂", original_text_bytes=10)).original_text_bytes == 10


def test_unreadable_flags(payload):
    """Go: mail_inbox_worker.go:186 (needs_review, or html_omitted with an empty body)."""
    assert parse_mail_event(with_message(payload, needs_review=True)).unreadable
    assert parse_mail_event(with_message(payload, html_omitted=True, text="")).unreadable
    assert not parse_mail_event(with_message(payload, html_omitted=True)).unreadable


def mutate(payload, path, value) -> bytes:
    changed = copy.deepcopy(payload)
    target = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return encode(changed)


REJECTED = [
    (("type",), "mail.received.v2"),
    (("event_id",), "not-a-uuid"),
    (("event_id",), "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001\n"),
    (("event_id",), 42),
    (("received_at",), "2026-09-23T16:00:00+00:00"),
    (("received_at",), "2026-09-23 16:00:00Z"),
    (("received_at",), "2026-02-30T16:00:00Z"),
    (("received_at",), "0001-01-01T00:00:00Z"),
    (("received_at",), "２０２６-09-23T16:00:00Z"),
    (("message",), []),
    (("message", "id"), "nope"),
    (("message", "subject"), None),
    (("message", "text"), 5),
    (("message", "from"), {}),
    (("message", "from"), [{"address": "a@example.org"}]),
    (("message", "to"), [{"address": 1, "name": ""}]),
    (("message", "from"), [{"address": "a@example.org", "name": ""}] * 51),
    (("message", "sent_at"), "yesterday"),
    (("message", "rfc_message_id"), 7),
    (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": -1}]),
    (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": 1.0}]),
    (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": True}]),
    (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": 1, "storage_status": ""}]),
    (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": 1, "omitted_reason": ["x"]}]),
    (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": 1}] * 101),
    (("message", "text_truncated"), None),
    (("message", "needs_review"), "true"),
    (("message", "warnings"), ["ok", 1]),
    (("message", "original_text_bytes"), 19.0),
]


@pytest.mark.parametrize(("path", "value"), REJECTED)
def test_invalid_fields_are_rejected(payload, path, value):
    with pytest.raises(ContractError):
        parse_mail_event(mutate(payload, path, value))


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("event_id",), "F8C1E9A0-1A98-4FB8-8CA1-4C0A3E710001"),
        (("message", "sent_at"), "2026-09-23T16:00:00.123456789+05:30"),
        (("message", "rfc_message_id"), "<id@example.org>"),
        (("message", "future_field"), {"anything": [1, 2]}),
        (("unknown_top_level",), True),
        (("message", "from"), [{"address": "a@example.org", "name": "", "extra": 1}] * 50),
        (("message", "attachments"), [{"filename": "a", "content_type": "b", "size": 0}] * 100),
        (("message", "subject"), "   "),
    ],
)
def test_compatible_variants_are_accepted(payload, path, value):
    parse_mail_event(mutate(payload, path, value))


@pytest.mark.parametrize(
    "value", ["+010000-01-01T00:00:00.000Z", "-000001-12-31T23:59:59.999Z", "0000-01-01T00:00:00.000Z"]
)
def test_javascript_years_python_cannot_hold_read_as_unknown_send_time(payload, value):
    assert parse_mail_event(mutate(payload, ("message", "sent_at"), value)).sent_at is None


@pytest.mark.parametrize("value", ["+010000-01-01T00:00:00.000+01:00", "+10000-01-01T00:00:00Z", 2026])
def test_other_unrepresentable_send_times_are_still_rejected(payload, value):
    with pytest.raises(ContractError):
        parse_mail_event(mutate(payload, ("message", "sent_at"), value))


def test_subject_and_text_limits_count_utf8_bytes(payload):
    ok_subject = "字" * 1365  # 4095 bytes
    parse_mail_event(with_message(payload, subject=ok_subject + "a"))
    with pytest.raises(ContractError):
        parse_mail_event(with_message(payload, subject=ok_subject + "字"))
    parse_mail_event(with_message(payload, text="a" * (256 << 10)))
    with pytest.raises(ContractError):
        parse_mail_event(with_message(payload, text="a" * (256 << 10) + "é"))


def test_blank_subject_and_text_are_rejected(payload):
    with pytest.raises(ContractError):
        parse_mail_event(with_message(payload, subject=" \t", text="\n"))


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"null",
        b"[]",
        b"{",
        b"\xef\xbb\xbf{}",
        b'{"type": NaN}',
        b"\xff\xfe",
        b"[" * 100_000 + b"]" * 100_000,
        b'{"a":"' + b"x" * (1 << 20) + b'"}',
    ],
)
def test_malformed_bodies_are_rejected(raw):
    with pytest.raises(ContractError):
        parse_mail_event(raw)


def test_lone_surrogate_escape_is_rejected(payload):
    raw = encode(payload).replace(b"Synthetic mail body", b"bad \\ud800 text")
    with pytest.raises(ContractError):
        parse_mail_event(raw)


def test_limits_match_the_published_schema():
    message = SCHEMA["properties"]["message"]
    assert tuple(SCHEMA["required"]) == contract.EVENT_FIELDS
    assert tuple(message["required"]) == contract.MESSAGE_FIELDS
    assert message["properties"]["from"]["maxItems"] == message["properties"]["to"]["maxItems"] == 50
    assert message["properties"]["attachments"]["maxItems"] == contract.MAX_ATTACHMENTS
    attachment = SCHEMA["$defs"]["attachment"]
    assert tuple(attachment["required"]) == contract.ATTACHMENT_FIELDS
    assert set(attachment["properties"]["storage_status"]["enum"]) == contract.STORAGE_STATUSES
    assert set(attachment["properties"]["omitted_reason"]["enum"]) == contract.OMITTED_REASONS
    assert tuple(SCHEMA["$defs"]["address"]["required"]) == contract.ADDRESS_FIELDS
    assert SCHEMA["properties"]["type"]["const"] == contract.EVENT_TYPE
