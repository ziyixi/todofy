"""Synthetic legacy databases for the migration tests; no real mail anywhere.

``build`` writes an inbox.sqlite and a todofy.db with the Go service's exact
DDL (inbox_schema.sql, todofy_schema.sql) and returns what the export should
find. Contents: 40 Mail Hero cache rows (39 linked to ledger events, 1 whose
event is missing), an older duplicate of one Mail Hero hash, a soft-deleted
row, and 8 CloudMailin-era rows (6 hashes, a newer duplicate of one of them,
one blank hash). One Mail Hero text is 120,000 characters of mixed CJK/ASCII
with every character that is awkward inside a SQL file.
"""

from __future__ import annotations

import hashlib
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
SOURCE_ID = "mail-hero-personal"
BASE = 1_788_000_000  # 2026-08-29, whole seconds
EVENTS = 40
LONG_TEXT_EVENT = 7
NAMESPACE = uuid.UUID("5f0c2a8e-3d1b-4e7a-9c6f-0a1b2c3d4e5f")

# Everything a naive SQL splitter or string literal could trip on.
AWKWARD = "it's; -- not a comment /* nor this */ $$tag$$ \\ \r\n\t\x00 end 😀 测试"
ESCAPED_SUBJECT = "Q3 &amp; Q4 &lt;report&gt; &#39;draft&#39; &#34;final&#34;"
UNESCAPED_SUBJECT = "Q3 & Q4 <report> 'draft' \"final\""


def event_id(index: int) -> str:
    return str(uuid.uuid5(NAMESPACE, f"event-{index}"))


def mailhero_hash(event: str) -> str:
    return "mailhero-v1-" + hashlib.sha256(f"{SOURCE_ID}\x00{event}".encode()).hexdigest()


def gorm_time(epoch: int, nanos: int = 0, offset_minutes: int = 0) -> str:
    """mattn/go-sqlite3's format: '2006-01-02 15:04:05.999999999-07:00'."""
    zone = timezone(timedelta(minutes=offset_minutes))
    moment = datetime.fromtimestamp(epoch, zone)
    fraction = f".{nanos:09d}".rstrip("0") if nanos else ""
    sign = "-" if offset_minutes < 0 else "+"
    hours, minutes = divmod(abs(offset_minutes), 60)
    return f"{moment:%Y-%m-%d %H:%M:%S}{fraction}{sign}{hours:02d}:{minutes:02d}"


def todo_body(subject: str, summary: str, event: str | None = None) -> str:
    footer = f"\n\nMail Hero event: {event}" if event else ""
    return (
        "**FROM: sender@example.com**\n**DATE: 2026-09-01T00:00:00Z**\n**RECEIVED: me@example.com**\n"
        f"**SUBJECT: {subject}**\n\n{'=' * 24}\n{summary}{footer}"
    )


def long_text() -> str:
    unit = "合成邮件正文 synthetic body " + AWKWARD + "\n"
    return (unit * (120_000 // len(unit) + 1))[:120_000]


def _entry(
    db: sqlite3.Connection,
    *,
    created: str,
    updated: str,
    model: int,
    text: str,
    summary: str,
    hash_id: str,
    deleted: str | None = None,
) -> None:
    db.execute(
        "INSERT INTO database_entries (created_at, updated_at, deleted_at, model_family, llm_model, prompt,"
        " max_tokens, text, summary, hash_id) VALUES (?, ?, ?, 1, ?, 'synthetic prompt', 0, ?, ?, ?)",
        (created, updated, deleted, model, text, summary, hash_id),
    )


def build(directory: Path) -> dict:
    """Write inbox.sqlite and todofy.db into ``directory``; return the expected export facts."""
    inbox = sqlite3.connect(directory / "inbox.sqlite")
    inbox.executescript((HERE / "inbox_schema.sql").read_text())
    legacy = sqlite3.connect(directory / "todofy.db")
    legacy.executescript((HERE / "todofy_schema.sql").read_text())

    for index in range(EVENTS):
        event = event_id(index)
        ignored = index == EVENTS - 1
        inbox.execute(
            "INSERT INTO mail_inbox_events (source_id, event_id, payload_hash, payload, state, summary_model,"
            " task_id, attempt_count, last_error_code, created_at, updated_at)"
            " VALUES (?, ?, ?, NULL, ?, 12, ?, ?, ?, ?, ?)",
            (
                SOURCE_ID,
                event,
                hashlib.sha256(f"payload-{index}".encode()).digest(),
                "ignored" if ignored else "complete",
                "" if ignored else str(9_000_000_000 + index),
                1 + index % 3,
                "mail_needs_review" if ignored else "",
                BASE + index * 3600,
                BASE + index * 3600 + 120,
            ),
        )
        if ignored:
            continue
        subject = {0: ESCAPED_SUBJECT, 1: "中文主题：季度报告"}.get(index, f"Synthetic subject {index}")
        summary = todo_body(subject, f"Synthetic summary {index}.", event)
        if index == 2:
            summary = "Synthetic summary without a task header."
        text = long_text() if index == LONG_TEXT_EVENT else f"Synthetic text {index}. {AWKWARD}"
        model = {3: 0, 4: 99}.get(index, 8 + index % 11)
        created = gorm_time(BASE + index * 3600 + 60, 123456789 * (index % 2), -420 if index % 4 == 0 else 0)
        _entry(
            db=legacy,
            created=created,
            updated=gorm_time(BASE + index * 3600 + 90),
            model=model,
            text=text,
            summary=summary,
            hash_id=mailhero_hash(event),
        )

    # A Mail Hero cache row whose event is not in the ledger.
    orphan = event_id(1000)
    _entry(
        db=legacy,
        created=gorm_time(BASE + 50),
        updated=gorm_time(BASE + 50),
        model=12,
        text="Orphan text.",
        summary=todo_body("Orphan", "Orphan summary.", orphan),
        hash_id=mailhero_hash(orphan),
    )
    # A later-inserted but older duplicate of event 0: the newest updated_at must win, not the highest id.
    _entry(
        db=legacy,
        created=gorm_time(BASE + 60),
        updated=gorm_time(BASE + 61),
        model=12,
        text="Stale copy.",
        summary=todo_body("Stale", "Stale summary."),
        hash_id=mailhero_hash(event_id(0)),
    )
    # Soft-deleted rows are never exported.
    _entry(
        db=legacy,
        created=gorm_time(BASE),
        updated=gorm_time(BASE),
        model=12,
        text="Deleted.",
        summary=todo_body("Deleted", "Deleted."),
        hash_id=mailhero_hash(event_id(5)),
        deleted=gorm_time(BASE + 10),
    )

    cloudmailin_start = BASE - 400 * 86400
    for index in range(6):
        created = gorm_time(cloudmailin_start + index * 86400, 5000, 480)
        _entry(
            db=legacy,
            created=created,
            updated=created,
            model=index + 1,
            text=f"CloudMailin text {index}.",
            summary=todo_body(f"Old mail {index}", f"Old summary {index}."),
            hash_id=hashlib.sha256(f"cloudmailin-{index}".encode()).hexdigest(),
        )
    _entry(
        db=legacy,
        created=gorm_time(cloudmailin_start),
        updated=gorm_time(cloudmailin_start + 5),
        model=9,
        text="CloudMailin text 0, newer.",
        summary=todo_body("Old mail 0 (newer)", "Newer."),
        hash_id=hashlib.sha256(b"cloudmailin-0").hexdigest(),
    )
    _entry(
        db=legacy,
        created=gorm_time(cloudmailin_start + 7 * 86400),
        updated=gorm_time(cloudmailin_start),
        model=2,
        text="",
        summary="No header, no hash.",
        hash_id="",
    )

    for day, state, task, code in (
        ("2026-09-20", "created", "8000000001", ""),
        ("2026-09-21", "unknown", "", "reminder_result_unknown"),
        ("2026-09-22", "failed", "", "reminder_create_failed"),
    ):
        inbox.execute(
            "INSERT INTO mail_inbox_reminders (day, state, task_id, subject, body, attention_count, attempts,"
            " next_attempt_at, last_error_code, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 'body', 2, 1, ?, ?, ?, ?)",
            (day, state, task, f"subject {day}", BASE + 3600 if state == "failed" else 0, code, BASE, BASE + 1),
        )
    for db in (inbox, legacy):
        db.commit()
        db.close()
    return {
        "ledger_rows": EVENTS,
        "state_counts": {"complete": EVENTS - 1, "ignored": 1},
        "reminder_rows": 3,
        "mailhero_summaries": EVENTS,  # 39 linked + 1 orphan
        "cloudmailin_summaries": 7,  # 6 hashes + 1 blank hash
        "texts_mailhero": EVENTS,
        "texts_cloudmailin": 6,  # the blank-hash row has no text
    }
