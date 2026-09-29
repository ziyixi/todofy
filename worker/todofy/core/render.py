"""Model input and Todoist task text for one mail event.

Byte-compatible with the Go worker (mail_inbox_worker.go:120-173 and
templates/todoDescription.tmpl @ 6c46ed4) except for two deliberate fixes:
nothing is HTML-escaped (Markdown, not HTML) and a stray ``#tag`` becomes a
single space instead of ``<removed tag>``.
"""

import re
from datetime import UTC, datetime

from .contract import MailEvent, utf8_len

NO_SUBJECT = "(No subject)"
FOOTER_PREFIX = "Mail Hero event: "
SUBJECT_LABEL = "**SUBJECT: "
SEPARATOR = "=" * 24

# Go's RE2 \s is ASCII-only [\t\n\f\r ]; Python's \s would also eat Unicode spaces.
_TAG = re.compile(r"[\t\n\f\r ]#[a-zA-Z0-9]{1,10}[\t\n\f\r ]")


def rfc3339(moment: datetime) -> str:
    """UTC, whole seconds, ``Z`` suffix: Go's ``time.RFC3339`` output."""
    t = moment.astimezone(UTC)
    return f"{t.year:04d}-{t.month:02d}-{t.day:02d}T{t.hour:02d}:{t.minute:02d}:{t.second:02d}Z"


def content_notice(event: MailEvent) -> str:
    """Disclosure that Mail Hero cut the body; empty for a complete body."""
    if not event.text_truncated:
        return ""
    return (
        f"正文不完整：原文 {event.original_text_bytes} bytes，"
        f"仅收到前 {utf8_len(event.text)} bytes，摘要可能遗漏尾部内容。"
    )


def summary_input(event: MailEvent) -> str:
    """Text the model summarises: the body, or the subject for a body-less mail."""
    text = event.text if event.text.strip() else event.subject
    notice = content_notice(event)
    return f"{notice}\n\n{text}" if notice else text


def clean_summary(model_output: str, event: MailEvent) -> str:
    """Strip tag-like tokens Todoist would turn into labels; restate any truncation."""
    summary = _TAG.sub(" ", model_output)
    notice = content_notice(event)
    return f"{notice}\n\n{summary}" if notice else summary


def task_title(event: MailEvent) -> str:
    # mail.received.v1 allows a body-only mail but Todoist needs a title.
    return event.subject if event.subject.strip() else NO_SUBJECT


def render_todo_body(event: MailEvent, summary: str) -> str:
    """The Todoist task description, ending in the event footer used for lookup."""
    sender = event.from_addresses[0].address if event.from_addresses else ""
    recipient = event.to_addresses[0].address if event.to_addresses else ""
    sent = rfc3339(event.sent_at or event.received_at)
    return (
        f"**FROM: {sender}**\n"
        f"**DATE: {sent}**\n"
        f"**RECEIVED: {recipient}**\n"
        f"{SUBJECT_LABEL}{event.subject}**\n\n"
        f"{SEPARATOR}\n"
        f"{summary}\n\n{FOOTER_PREFIX}{event.event_id}"
    )


def has_footer(description: str, event_id: str) -> bool:
    """Whether a task description carries this event's footer (and not a longer ID)."""
    return re.search(re.escape(FOOTER_PREFIX + event_id) + r"(?![0-9A-Za-z-])", description) is not None
