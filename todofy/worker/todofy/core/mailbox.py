"""Mail's domain rules (docs/mail-api.md): what the Mail entry answers about a mail Todofy keeps.

A mail item is a Mail Hero event Todofy summarised (its ``summaries`` row): its ID is the event ID, its task the ID
of the Tasks task it was converted to. Its brief is one plain sentence, the first line the summary prompt asks for
(core/prompts.SUMMARY_EMAIL); ``brief_of`` reads it from any summary, older ones included. Todofy keeps no task
fields: Tasks converts a mail itself and owns the categories it files with (runtime/mail.py).
"""

import hashlib
import json
import re
from base64 import b64decode, urlsafe_b64encode

# What a read takes of a summary to find its brief: substr(summary, 1, 600).
BRIEF_SOURCE_CHARS = 600
# A brief is cut at this many characters, the last one an ellipsis.
MAX_BRIEF_CHARS = 60
# Lines that are never the brief: the truncation notice (core/render.content_notice), the header of a Todoist task
# description, which older imported summaries carry, and the separator under it.
_NOTICE = "正文不完整："
_HEADERS = ("**FROM:", "**DATE:", "**RECEIVED:", "**SUBJECT:")
_RULE = re.compile(r"^([=\-*_])\1{2,}$")
_LEADING_MARK = re.compile(r"^(?:[-*>]|\d{1,3}[.)])\s+")
_SENTENCE = re.compile(r"[。！？]|[.!?](?=\s|$)")
_ENDS = ("。", "！", "？", ".", "!", "?")


def item_etag(row: dict) -> str:
    """The immutable summary identity and its mutable task/triage link, without reading the full text."""
    values = [row[key] for key in ("event_id", "created_at", "subject", "task_id", "triaged_at")]
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def page_cursor(token: str) -> tuple[int, str]:
    """One bounded, opaque keyset cursor; empty starts before the newest row."""
    if not token:
        return 2**52, ""
    try:
        if len(token) > 256:
            raise ValueError
        at, event_id = json.loads(b64decode(token, altchars=b"-_", validate=True))
        if type(at) is not int or not 0 <= at < 2**52 or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", event_id):
            raise ValueError
        return at, event_id
    except (ValueError, TypeError):
        raise ValueError("BAD_REQUEST") from None


def next_page(row: dict) -> str:
    value = json.dumps([row["created_at"], row["event_id"]], separators=(",", ":")).encode()
    return urlsafe_b64encode(value).decode()


def _heading(line: str) -> bool:
    """A line that names a section rather than says something: a markdown heading, a wholly bold line that is no
    sentence (a bold sentence is still the brief), or a short line that ends in a colon."""
    bold = len(line) > 4 and line.startswith("**") and line.endswith("**") and not line[:-2].endswith(_ENDS)
    return line.startswith("#") or bold or (len(line) <= 20 and line.endswith(("：", ":")))


def _plain(line: str) -> str:
    """The line without markdown: list and quote marks first, then bold, underline and code marks; one space for
    each run of whitespace."""
    while (stripped := _LEADING_MARK.sub("", line)) != line:
        line = stripped
    for mark in ("**", "__", "`"):
        line = line.replace(mark, "")
    return " ".join(line.split())


def brief_of(text: str) -> str:
    """The one-sentence brief of a summary, or "" when it has none (the Mailbox then shows the title alone).

    The first line of the first BRIEF_SOURCE_CHARS characters that is not blank, a notice, a header, a rule or a
    heading, without markdown, up to the end of its first sentence (。！？, or .!? before a space or the line's
    end), at most MAX_BRIEF_CHARS characters.
    """
    for raw in text[:BRIEF_SOURCE_CHARS].splitlines():
        line = raw.strip()
        if not line or line.startswith((_NOTICE, *_HEADERS)) or _RULE.match(line) or _heading(line):
            continue
        line = _plain(line)
        if not line:
            continue
        end = _SENTENCE.search(line)
        sentence = line[: end.end()] if end else line
        if len(sentence) > MAX_BRIEF_CHARS:
            sentence = sentence[: MAX_BRIEF_CHARS - 1] + "…"
        return sentence
    return ""


# ---- the Mail entry's requests ---------------------------------------------------------------------------------

ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")


def check_id(value: str) -> str:
    """A mail or task ID a request names; never a browser's temporary ID (tmp-…)."""
    if not ID.fullmatch(value) or value.startswith("tmp-"):
        raise ValueError("BAD_REQUEST")
    return value
