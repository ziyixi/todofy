"""The summary text of one mail event, and the times the APIs write.

Byte-compatible with the Go worker (mail_inbox_worker.go:120-173 @ 6c46ed4)
except for one deliberate fix: a stray ``#tag`` becomes a single space instead
of ``<removed tag>``. The Todoist task description Todofy wrote until 2026-10-21
(``**FROM:`` ... ``**SUBJECT: `` ..., the summary, then ``Mail Hero event: <id>``)
survives only in older rows' ``todo_body`` and in imported summaries.
"""

import re
from datetime import UTC, datetime

from .contract import MailEvent, utf8_len

NO_SUBJECT = "(No subject)"
# The subject line of that task description, which tools/legacy_migration reads from the retired Go cache.
SUBJECT_LABEL = "**SUBJECT: "

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


def clean_summary(model_output: str, event: MailEvent) -> str:
    """Strip tag-like tokens Todoist would turn into labels; restate any truncation."""
    summary = _TAG.sub(" ", model_output)
    notice = content_notice(event)
    return f"{notice}\n\n{summary}" if notice else summary
