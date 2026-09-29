"""Owner API reads (runtime/api.py). Pages are keyset cursors on (created_at, event_id).

List pages never select mail content (payload, summary, todo_body). A first
page binds a sentinel cursor that sorts before every row: (2**52, '') for the
newest-first pages, (-1, '') for the oldest-first attention page.

Lists and counts leave canary events out (REAL_MAIL); the event detail (the
coordinator's ledger read) still answers for one, marked as a canary.
"""

from . import ACTIVE, ATTENTION, DUE, REAL_MAIL, Query

# The EventSummary columns, in the order runtime/api.py reads them.
EVENT_SUMMARY = (
    "event_id, state, last_error_code, attempt_count, task_id, created_at, updated_at, next_attempt_at, imported"
)

ATTENTION_PAGE = Query(
    f"SELECT {EVENT_SUMMARY} FROM mail_events"
    f" WHERE source_id = ? AND {ACTIVE} AND {ATTENTION} AND {REAL_MAIL} AND (created_at, event_id) > (?, ?)"
    f" ORDER BY created_at, event_id LIMIT ?",
    "mail_events_active",
)
ATTENTION_COUNT = Query(
    f"SELECT count(*) AS n FROM mail_events WHERE source_id = ? AND {ACTIVE} AND {ATTENTION} AND {REAL_MAIL}",
    "mail_events_by_state",
)
ACTIVE_COUNTS = Query(
    f"SELECT state, count(*) AS n FROM mail_events WHERE source_id = ? AND {ACTIVE} AND {REAL_MAIL} GROUP BY state",
    "mail_events_by_state",
)
RECEIVED_SINCE = Query(
    f"SELECT count(*) AS n FROM mail_events WHERE source_id = ? AND created_at > ? AND {REAL_MAIL}",
    "mail_events_recent",
)
# A due row whose next_attempt_at is 0 has been due since it arrived.
OLDEST_DUE = Query(
    f"SELECT min(max(next_attempt_at, created_at)) AS at FROM mail_events"
    f" WHERE {DUE} AND next_attempt_at <= ? AND {REAL_MAIL}",
    "mail_events_due",
)
RECENT_PAGE = Query(
    f"SELECT {EVENT_SUMMARY} FROM mail_events WHERE source_id = ? AND (created_at, event_id) < (?, ?)"
    f" AND {REAL_MAIL} ORDER BY created_at DESC, event_id DESC LIMIT ?",
    "mail_events_recent",
)
RECENT_PAGE_BY_STATE = Query(
    f"SELECT {EVENT_SUMMARY} FROM mail_events WHERE source_id = ? AND state = ? AND (created_at, event_id) < (?, ?)"
    f" AND {REAL_MAIL} ORDER BY created_at DESC, event_id DESC LIMIT ?",
    "mail_events_by_state",
)
TIMELINE = Query(
    "SELECT at, from_state, to_state, error_code, actor FROM event_transitions"
    " WHERE event_id = ? ORDER BY at, id LIMIT ?",
    "event_transitions_event",
)
SUMMARY_OF_EVENT = Query("SELECT * FROM summaries WHERE event_id = ?", "sqlite_autoindex_summaries_1")
# Whether an event has imported text it may still show, without reading the text.
LEGACY_TEXT_READABLE = Query(
    "SELECT 1 FROM legacy_mail_text WHERE event_id = ? AND (expires_at IS NULL OR expires_at > ?)",
    "sqlite_autoindex_legacy_mail_text_1",
)
LEGACY_TEXT = Query(
    "SELECT event_id, created_at, expires_at, text FROM legacy_mail_text WHERE event_id = ?",
    "sqlite_autoindex_legacy_mail_text_1",
)
