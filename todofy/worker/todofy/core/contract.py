"""Validation of Mail Hero ``mail.received.v1`` events.

The event is proto/mailhero/webhook/v1/mail_received.proto (``ziyixi_proto.mailhero.webhook.v1``): every body is
read with the wire codec, leniently, as a consumer reads a producer's output: a field Mail Hero adds later is
skipped, and every rule of the contract is checked (types, REQUIRED fields, UUIDs, UTC times, list sizes, the
attachments' closed enums, the canary's run ID, a subject or a text that is not blank, the size before truncation of
a truncated text). The published schema (contracts/mail-received-v1/mail-received-v1.schema.json) is generated from
the same IDL. What a rule cannot say stays here, as the Go consumer (mail_inbox.go:67-122 @ 6c46ed4) and this module
always checked it: the body's 1 MiB, the subject's 4 KiB and the text's 256 KiB of UTF-8, no lone surrogate, integers
written as JSON integers, a real calendar time (``received_at`` UTC with ``Z``, never year 1's zero time), sizes
before truncation consistent with the text. A ``sent_at`` year Python cannot hold reads as unknown rather than
failing. Every body the parser before the IDL accepted is accepted, as the same event, but one with an integer above
2^31 - 1 (the profile's integers are int32; no 25 MiB message has such a size), and refused with the same log reason:
tests/unit/test_mail_received_parser_legacy.py compares the two on every fixture and about 9,000 mutations.

The optional top-level ``canary`` marks a synthetic end-to-end check (contracts/ops-v1):
Todofy processes it through Gemini but never causes a side effect for it. A marker that is
present but unreadable is rejected (400, nothing stored) rather than guessed at.
"""

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NoReturn

from ziyixi_proto.mailhero.webhook.v1 import mail_received_pb as pb
from ziyixi_proto.wire_json import WireJsonError, field_rules, from_wire, wire_name

EVENT_TYPE = "mail.received.v1"
MAX_EVENT_BYTES = 1 << 20
MAX_SUBJECT_BYTES = 4096
MAX_TEXT_BYTES = 256 << 10
# The contract's sizes, read where mail_received.proto states them.
MAX_ADDRESSES = field_rules(pb.Mail, "from").max_items
MAX_ATTACHMENTS = field_rules(pb.Mail, "attachments").max_items

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE | re.ASCII)
# [0-9], not \d: Python's \d also matches non-ASCII digits.
_RFC3339 = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})"
)
# Mail Hero sends toISOString() of the sender's Date header; for a year outside
# 1..9999 Python cannot represent it, so the send time is unknown.
_JS_OUT_OF_RANGE = re.compile(r"(?:[+-][0-9]{6}|0000)-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z")
_ZERO_TIME = datetime(1, 1, 1, tzinfo=UTC)
# The codec reads 1.0 as the integer 1 (JSON Schema's rule, and JavaScript's); this consumer has always refused a
# fraction where the contract has an integer.
_INTEGERS = ("original_text_bytes", "attachments_omitted_count")
# A codec error is "<path>: <rule>" (never a value). The log-safe reason this module has always given for it: a
# missing field or a wrong type is "shape", except where a field's own check came first.
_FIELD_REASONS = {
    "type": "type",
    "event_id": "uuid",
    "received_at": "timestamp",
    "message.id": "uuid",
    "message.sent_at": "timestamp",
}


class ContractError(ValueError):
    """The body is not an acceptable event; ``reason`` is a log-safe short code."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class Address:
    address: str
    name: str


@dataclass(frozen=True, slots=True)
class Attachment:
    filename: str
    content_type: str
    size: int
    storage_status: str | None = None
    omitted_reason: str | None = None


@dataclass(frozen=True, slots=True)
class MailEvent:
    event_id: str
    received_at: datetime
    message_id: str
    from_addresses: tuple[Address, ...]
    to_addresses: tuple[Address, ...]
    subject: str
    sent_at: datetime | None
    rfc_message_id: str | None
    text: str
    attachments: tuple[Attachment, ...]
    text_truncated: bool = False
    original_text_bytes: int | None = None
    html_omitted: bool = False
    needs_review: bool = False
    warnings: tuple[str, ...] = ()
    content_policy_version: str = ""
    attachments_omitted_count: int = 0
    # The dashboard's run of a canary event; None for real mail.
    canary_run_id: str | None = None

    @property
    def unreadable(self) -> bool:
        """Mail Hero could not produce usable text; never guess a summary for it."""
        return self.needs_review or (self.html_omitted and not self.text.strip())


def utf8_len(value: str) -> int:
    try:
        return len(value.encode())
    except UnicodeEncodeError:  # a lone surrogate from a "\ud800" escape
        raise ContractError("invalid_text") from None


def parse_mail_event(raw: bytes) -> MailEvent:
    """Validate the exact webhook bytes and return the typed event."""
    if not raw or len(raw) > MAX_EVENT_BYTES:
        raise ContractError("size")
    try:
        document = json.loads(raw.decode(), parse_constant=_reject_constant)
    except (ValueError, RecursionError):  # UnicodeDecodeError is a ValueError
        raise ContractError("json") from None
    try:
        read = from_wire(pb.MailReceivedEvent, document).message
    except WireJsonError as error:
        raise ContractError(_reason(str(error), document)) from None
    _check_integers(document["message"])
    message = read.message
    for value in _strings(read):
        utf8_len(value)
    received_at = _timestamp(read.received_at)
    if received_at == _ZERO_TIME:
        raise ContractError("received_at")
    # A blank subject and text ("empty") never get here: the codec checked Mail.any_match, whose Visible is exactly
    # the whitespace str.strip() removes (tests/unit/test_contract.py pins both).
    if utf8_len(message.subject) > MAX_SUBJECT_BYTES or utf8_len(message.text) > MAX_TEXT_BYTES:
        raise ContractError("too_long")
    event = MailEvent(
        event_id=read.event_id,
        received_at=received_at,
        message_id=message.id,
        from_addresses=tuple(Address(a.address, a.name) for a in message.from_),
        to_addresses=tuple(Address(a.address, a.name) for a in message.to),
        subject=message.subject,
        sent_at=_sent_at(message.sent_at),
        rfc_message_id=message.rfc_message_id,
        text=message.text,
        attachments=tuple(
            Attachment(a.filename, a.content_type, a.size, wire_name(a.storage_status), wire_name(a.omitted_reason))
            for a in message.attachments
        ),
        text_truncated=bool(message.text_truncated),
        original_text_bytes=message.original_text_bytes,
        html_omitted=bool(message.html_omitted),
        needs_review=bool(message.needs_review),
        warnings=message.warnings,
        content_policy_version=message.content_policy_version or "",
        attachments_omitted_count=message.attachments_omitted_count or 0,
        canary_run_id=None if read.canary is None else read.canary.run_id,
    )
    _check_content_policy(event)
    return event


def _reason(error: str, document: Any) -> str:
    """The log-safe reason of a codec error ("<path>: <rule>"), the one the checks before the IDL gave."""
    path, _, rule = error.partition(": ")
    if path == "canary" or path.startswith("canary."):
        return "canary"
    if rule.startswith("no value of"):  # Mail.any_match: neither the subject nor the text is Visible
        return "empty"
    if rule == "missing" or path in ("$", "message"):
        return "shape"
    if path == "received_at" and isinstance(time := document["received_at"], str) and _RFC3339.fullmatch(time):
        return "received_at"  # a time, but not in UTC with Z
    if path in _FIELD_REASONS:
        return _FIELD_REASONS[path]
    if rule.startswith("more than"):
        return "too_many"
    if rule.startswith("required when"):  # original_text_bytes' present_when
        return "policy"
    if path.startswith("message.attachments[") and path.endswith(("storage_status", "omitted_reason")):
        return "attachment"
    return "shape"


def _check_integers(message: dict[str, Any]) -> None:
    """The contract's integers as JSON integers (the codec has already checked their range and types)."""
    values = [message[name] for name in _INTEGERS if name in message]
    values += [item["size"] for item in message["attachments"]]
    if any(type(value) is not int for value in values):
        raise ContractError("shape")


def _strings(read: Any) -> Iterator[str]:
    """Every string of a read event: each must be encodable (a "\\ud800" escape reads as a lone surrogate)."""
    message = read.message
    yield read.received_at
    if read.canary is not None:
        yield read.canary.run_id
    for address in (*message.from_, *message.to):
        yield address.address
        yield address.name
    yield from (message.subject, message.text, *message.warnings)
    yield from (value for value in (message.sent_at, message.rfc_message_id, message.content_policy_version) if value)
    for attachment in message.attachments:
        yield attachment.filename
        yield attachment.content_type


def _check_content_policy(event: MailEvent) -> None:
    # A sender must not label an incomplete body as complete through
    # inconsistent sizes; older frozen events may omit the fields entirely.
    size = utf8_len(event.text)
    original = event.original_text_bytes
    if original is not None and (original < size or (not event.text_truncated and original != size)):
        raise ContractError("policy")
    if event.text_truncated and (original is None or original <= size):
        raise ContractError("policy")


def _reject_constant(name: str) -> NoReturn:
    raise ValueError(name)


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str) or not _RFC3339.fullmatch(value):
        raise ContractError("timestamp")
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise ContractError("timestamp") from None


def _sent_at(value: Any) -> datetime | None:
    if value is None or (isinstance(value, str) and _JS_OUT_OF_RANGE.fullmatch(value)):
        return None
    return _timestamp(value)
