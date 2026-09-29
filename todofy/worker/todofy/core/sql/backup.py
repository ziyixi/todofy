"""D1 reads of the weekly backup (runtime/backup.py): rowid keyset pages, never OFFSET.

Every table is a rowid table, so a page is a range search on the integer primary
key: ``rowid > last AND rowid <= max`` reads exactly the rows it returns, and the
``max`` taken when the job starts bounds the snapshot to the rows that existed
then. These statements are generated per table rather than written as ``Query``
constants (a rowid search names no index); tests/unit/test_backup.py checks their
plans and that each column list is the whole table.

``mail_events.payload`` (up to 1 MiB per row) is left out of the page and read
by rowid for at most ``DEFERRED_ROWS`` rows at a time, so a page of events never
holds more than a few MiB of mail.
"""

from typing import NamedTuple


class Table(NamedTuple):
    name: str
    columns: tuple[str, ...]  # every column, in export order; restore inserts them by name
    key: tuple[str, ...]  # the primary key (restore appends long values by it)
    page_rows: int
    deferred: str | None = None  # a large column read by rowid after the page


DEFERRED_ROWS = 8

MAIL_EVENTS = Table(
    "mail_events",
    (
        "source_id",
        "event_id",
        "payload_hash",
        "payload",
        "state",
        "version",
        "summary",
        "summary_model",
        "todo_body",
        "todoist_request_id",
        "task_id",
        "attempt_count",
        "crashes",
        "next_attempt_at",
        "last_error_code",
        "imported",
        "created_at",
        "updated_at",
    ),
    ("source_id", "event_id"),
    200,
    deferred="payload",
)
EVENT_TRANSITIONS = Table(
    "event_transitions", ("id", "event_id", "at", "from_state", "to_state", "error_code", "actor"), ("id",), 500
)
MAIL_REMINDERS = Table(
    "mail_reminders",
    (
        "day",
        "state",
        "task_id",
        "subject",
        "body",
        "attention_count",
        "attempts",
        "next_attempt_at",
        "last_error_code",
        "imported",
        "created_at",
        "updated_at",
    ),
    ("day",),
    500,
)
SUMMARIES = Table(
    "summaries", ("event_id", "created_at", "subject", "summary", "model", "task_id", "imported"), ("event_id",), 200
)
DAILY_REPORTS = Table(
    "daily_reports",
    (
        "kind",
        "top_n",
        "day",
        "status",
        "payload_json",
        "model",
        "task_count",
        "window_start",
        "window_end",
        "computed_at",
        "error_code",
    ),
    ("kind", "top_n", "day"),
    50,
)
OWNER_ACTIONS = Table(
    "owner_actions",
    ("owner", "action_request_id", "kind", "event_id", "request_hash", "result_ref", "http_status", "created_at"),
    ("owner", "action_request_id"),
    200,
)
AUTH_FAILURES = Table("auth_failures", ("hour", "count"), ("hour",), 500)
DAILY_METRICS = Table("daily_metrics", ("day", "key", "value"), ("day", "key"), 500)
# In every backup like the rest, so a text that retention deleted from D1 leaves R2 with the
# backups made before (restores of older backups never depend on a shared copy). Texts reach
# 1.9 MB, hence the small page.
LEGACY_MAIL_TEXT = Table("legacy_mail_text", ("event_id", "created_at", "text", "expires_at"), ("event_id",), 8)

TABLES = {
    table.name: table
    for table in (
        MAIL_EVENTS,
        EVENT_TRANSITIONS,
        MAIL_REMINDERS,
        SUMMARIES,
        DAILY_REPORTS,
        OWNER_ACTIONS,
        AUTH_FAILURES,
        DAILY_METRICS,
        LEGACY_MAIL_TEXT,
    )
}

# wrangler records applied migrations here; the newest name is the backup's schema version.
SCHEMA_VERSION = "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"


def max_rowid(table: Table) -> str:
    return f"SELECT max(rowid) AS n FROM {table.name}"


def page(table: Table) -> str:
    """Bind the last exported rowid, the snapshot's max rowid and the page size."""
    columns = ", ".join(
        f"{column} IS NOT NULL AS _deferred" if column == table.deferred else column for column in table.columns
    )
    return f"SELECT rowid AS _rid, {columns} FROM {table.name} WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?"


def deferred(table: Table, count: int) -> str:
    """The deferred column of ``count`` rows (1..DEFERRED_ROWS), bound by rowid."""
    return (
        f"SELECT rowid AS _rid, {table.deferred} AS value FROM {table.name} WHERE rowid IN ({', '.join('?' * count)})"
    )
