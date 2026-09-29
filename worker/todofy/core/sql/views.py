"""Owner API reads (runtime/api.py). Pages are keyset cursors on (created_at, event_id)."""

from . import ACTIVE, ATTENTION, Query

ATTENTION_PAGE = Query(
    f"SELECT event_id, state, last_error_code, created_at FROM mail_events"
    f" WHERE source_id = ? AND {ACTIVE} AND {ATTENTION} AND (created_at, event_id) > (?, ?)"
    f" ORDER BY created_at, event_id LIMIT ?",
    "mail_events_active",
)
ATTENTION_COUNT = Query(
    f"SELECT count(*) FROM mail_events WHERE source_id = ? AND {ACTIVE} AND {ATTENTION}", "mail_events_by_state"
)
ACTIVE_COUNTS = Query(
    f"SELECT state, count(*) FROM mail_events WHERE source_id = ? AND {ACTIVE} GROUP BY state",
    "mail_events_by_state",
)
RECEIVED_SINCE = Query("SELECT count(*) FROM mail_events WHERE source_id = ? AND created_at > ?", "mail_events_recent")
RECENT_FIRST_PAGE = Query(
    "SELECT event_id FROM mail_events WHERE source_id = ? ORDER BY created_at DESC, event_id DESC LIMIT ?",
    "mail_events_recent",
)
RECENT_PAGE = Query(
    "SELECT event_id FROM mail_events WHERE source_id = ? AND (created_at, event_id) < (?, ?)"
    " ORDER BY created_at DESC, event_id DESC LIMIT ?",
    "mail_events_recent",
)
RECENT_PAGE_BY_STATE = Query(
    "SELECT event_id FROM mail_events WHERE source_id = ? AND state = ? AND (created_at, event_id) < (?, ?)"
    " ORDER BY created_at DESC, event_id DESC LIMIT ?",
    "mail_events_by_state",
)
TIMELINE = Query(
    "SELECT at, from_state, to_state, error_code, actor FROM event_transitions"
    " WHERE event_id = ? ORDER BY at, id LIMIT ?",
    "event_transitions_event",
)
SUMMARY_OF_EVENT = Query("SELECT * FROM summaries WHERE event_id = ?", "sqlite_autoindex_summaries_1")
LEGACY_TEXT = Query("SELECT * FROM legacy_mail_text WHERE event_id = ?", "sqlite_autoindex_legacy_mail_text_1")
