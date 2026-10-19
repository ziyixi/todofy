"""The Mailbox's domain rules, independent of any task provider (docs/planning-api.md, "Mail").

A mail item is a Mail Hero event Todofy summarised (its ``summaries`` row): its ID is the event ID, its task an
external reference. Its brief is one plain sentence, the first line the summary prompt asks for
(core/prompts.SUMMARY_EMAIL); ``brief_of`` reads it from any summary, older ones included. The owner's mail
categories are an existing label and a priority each (P1-P4, 1 the most urgent); Tasks' Mail conversion
(runtime/plus_mail.py) adds the label and sets the priority.
"""

import hashlib
import json
import re
from base64 import b64decode, urlsafe_b64encode
from dataclasses import dataclass

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

# The owner's mail categories: at most this many, each one label and one priority.
MAX_MAIL_CATEGORIES = 4
PRIORITIES = (1, 2, 3, 4)
# plan_categories.name is at most 40 characters.
MAX_CATEGORY_NAME = 40


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


def task_text(text: str, units: int) -> str:
    """Tasks validates JavaScript string lengths, so a non-BMP character occupies two units."""
    return text.encode("utf-16-le")[: units * 2].decode("utf-16-le", errors="ignore")


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


@dataclass(frozen=True, slots=True)
class Category:
    """One saved mail category: Todofy's own ID (plan_categories.id), its label's ID and name as saved, and its
    domain priority (1 = P1)."""

    id: int
    label_id: str
    label: str
    priority: int

    @property
    def name(self) -> str:
        """plan_categories.name: generated, e.g. "quick · P4", at most MAX_CATEGORY_NAME characters."""
        suffix = f" · P{self.priority}"
        label = self.label
        if len(label) + len(suffix) > MAX_CATEGORY_NAME:
            label = label[: MAX_CATEGORY_NAME - len(suffix) - 1] + "…"
        return label + suffix


@dataclass(frozen=True, slots=True)
class MailSettings:
    """The saved categories, in their order, and the destination sent with the last change ("" until one was),
    never used for filing (runtime/plan_store.py MAIL_KEY)."""

    categories: tuple[Category, ...] = ()
    destination: str = ""

    @property
    def etag(self) -> str:
        """Changes with any category's ID, label or priority, their order, or the destination; not with a label's
        name, which Tasks owns."""
        value = [[[c.id, c.label_id, c.priority] for c in self.categories], self.destination]
        return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


def replace_categories(
    current: list[Category], requested: list[tuple[str, str, int]], next_id: int
) -> tuple[list[Category], list[int]]:
    """The categories saved for ``requested`` (label ID, label name, priority), in its order, and the IDs of the
    current ones to archive. A requested pair that a current category has keeps its ID (and takes the label's
    current name); every other one gets the next unused ID from ``next_id`` on.

    Raises ValueError("BAD_REQUEST") for more than MAX_MAIL_CATEGORIES, a priority outside P1-P4, the same pair
    twice, or two names that would be the same.
    """
    if len(requested) > MAX_MAIL_CATEGORIES or any(priority not in PRIORITIES for _, _, priority in requested):
        raise ValueError("BAD_REQUEST")
    if len({(label_id, priority) for label_id, _, priority in requested}) != len(requested):
        raise ValueError("BAD_REQUEST")
    kept = {(category.label_id, category.priority): category for category in current}
    saved = []
    for label_id, label, priority in requested:
        previous = kept.get((label_id, priority))
        if previous is None:
            saved.append(Category(next_id, label_id, label, priority))
            next_id += 1
        else:
            saved.append(Category(previous.id, label_id, label, priority))
    if len({category.name for category in saved}) != len(saved):
        raise ValueError("BAD_REQUEST")
    ids = {category.id for category in saved}
    return saved, [category.id for category in current if category.id not in ids]
