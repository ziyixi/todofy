"""Strict validation of Mail Hero ``mail.received.v1`` events.

Rules follow the Go consumer (mail_inbox.go:67-122 @ 6c46ed4) and the published
schema (the monorepo's contracts/mail-received-v1/mail-received-v1.schema.json).
Where they differ the schema wins: typed optional fields must have their JSON type
(Go silently accepted null), ``received_at`` must be UTC with ``Z`` and attachment
enums are checked. A ``sent_at`` year Python cannot hold reads as unknown rather than
failing. Unknown fields are ignored so Mail Hero can add optional ones.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NoReturn

EVENT_TYPE = "mail.received.v1"
MAX_EVENT_BYTES = 1 << 20
MAX_SUBJECT_BYTES = 4096
MAX_TEXT_BYTES = 256 << 10
MAX_ADDRESSES = 50
MAX_ATTACHMENTS = 100

EVENT_FIELDS = ("type", "event_id", "received_at", "message")
MESSAGE_FIELDS = ("id", "from", "to", "subject", "sent_at", "rfc_message_id", "text", "attachments")
ADDRESS_FIELDS = ("address", "name")
ATTACHMENT_FIELDS = ("filename", "content_type", "size")
STORAGE_STATUSES = frozenset({"stored", "omitted"})
OMITTED_REASONS = frozenset({"size_limit", "message_size_limit", "inline_image", "capacity"})

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE | re.ASCII)
# [0-9], not \d: Python's \d also matches non-ASCII digits.
_RFC3339 = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})"
)
# Mail Hero sends toISOString() of the sender's Date header; for a year outside
# 1..9999 Python cannot represent it, so the send time is unknown.
_JS_OUT_OF_RANGE = re.compile(r"(?:[+-][0-9]{6}|0000)-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z")
_ZERO_TIME = datetime(1, 1, 1, tzinfo=UTC)


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
    top = _object(document, EVENT_FIELDS)
    message = _object(top["message"], MESSAGE_FIELDS)
    if top["type"] != EVENT_TYPE:
        raise ContractError("type")
    received_at = _timestamp(top["received_at"])
    if not top["received_at"].endswith("Z") or received_at == _ZERO_TIME:
        raise ContractError("received_at")

    subject = _string(message["subject"])
    text = _string(message["text"])
    if not subject.strip() and not text.strip():
        raise ContractError("empty")
    if utf8_len(subject) > MAX_SUBJECT_BYTES or utf8_len(text) > MAX_TEXT_BYTES:
        raise ContractError("too_long")

    rfc_message_id = message["rfc_message_id"]
    event = MailEvent(
        event_id=_uuid(top["event_id"]),
        received_at=received_at,
        message_id=_uuid(message["id"]),
        from_addresses=_addresses(message["from"]),
        to_addresses=_addresses(message["to"]),
        subject=subject,
        sent_at=_sent_at(message["sent_at"]),
        rfc_message_id=None if rfc_message_id is None else _string(rfc_message_id),
        text=text,
        attachments=_attachments(message["attachments"]),
        text_truncated=_optional(message, "text_truncated", _boolean, False),
        original_text_bytes=_optional(message, "original_text_bytes", _integer, None),
        html_omitted=_optional(message, "html_omitted", _boolean, False),
        needs_review=_optional(message, "needs_review", _boolean, False),
        warnings=_optional(message, "warnings", _strings, ()),
        content_policy_version=_optional(message, "content_policy_version", _string, ""),
        attachments_omitted_count=_optional(message, "attachments_omitted_count", _integer, 0),
    )
    _check_content_policy(event)
    return event


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


def _object(value: Any, required: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict) or any(field not in value for field in required):
        raise ContractError("shape")
    return value


def _string(value: Any) -> str:
    if not isinstance(value, str):
        raise ContractError("shape")
    utf8_len(value)
    return value


def _uuid(value: Any) -> str:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ContractError("uuid")
    return value


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


def _boolean(value: Any) -> bool:
    if type(value) is not bool:
        raise ContractError("shape")
    return value


def _integer(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ContractError("shape")
    return value


def _strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ContractError("shape")
    return tuple(_string(item) for item in value)


def _choice(allowed: frozenset[str]) -> Callable[[Any], str]:
    def parse(value: Any) -> str:
        if not isinstance(value, str) or value not in allowed:
            raise ContractError("attachment")
        return value

    return parse


def _optional[T](obj: dict[str, Any], field: str, parse: Callable[[Any], T], default: T) -> T:
    return parse(obj[field]) if field in obj else default


def _array(value: Any, limit: int) -> list[Any]:
    if not isinstance(value, list):
        raise ContractError("shape")
    if len(value) > limit:
        raise ContractError("too_many")
    return value


def _addresses(value: Any) -> tuple[Address, ...]:
    return tuple(
        Address(_string(item["address"]), _string(item["name"]))
        for item in (_object(entry, ADDRESS_FIELDS) for entry in _array(value, MAX_ADDRESSES))
    )


def _attachments(value: Any) -> tuple[Attachment, ...]:
    return tuple(
        Attachment(
            filename=_string(item["filename"]),
            content_type=_string(item["content_type"]),
            size=_integer(item["size"]),
            storage_status=_optional(item, "storage_status", _choice(STORAGE_STATUSES), None),
            omitted_reason=_optional(item, "omitted_reason", _choice(OMITTED_REASONS), None),
        )
        for item in (_object(entry, ATTACHMENT_FIELDS) for entry in _array(value, MAX_ATTACHMENTS))
    )
