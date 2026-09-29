"""Ledger writes and scheduler reads (runtime/ledger.py, runtime/coordinator.py)."""

from . import DUE, Query

INGEST_HASH = Query(
    "SELECT payload_hash FROM mail_events WHERE source_id = ? AND event_id = ?",
    "sqlite_autoindex_mail_events_1",
)
STATE_CAS = Query(
    "UPDATE mail_events SET state = ?, version = version + 1, updated_at = ?"
    " WHERE source_id = ? AND event_id = ? AND state = ? AND version = ?",
    "sqlite_autoindex_mail_events_1",
)
NEXT_DUE = Query(
    f"SELECT event_id FROM mail_events WHERE {DUE} AND next_attempt_at <= ? ORDER BY created_at LIMIT 1",
    "mail_events_due",
    sort_allowed=True,
)
NEXT_WAKE = Query(f"SELECT min(next_attempt_at) FROM mail_events WHERE {DUE}", "mail_events_due")
# next_attempt_at = 0 means no lookup is scheduled.
LOOKUP_DUE = Query(
    "SELECT event_id FROM mail_events WHERE state = 'todo_unknown' AND next_attempt_at > 0"
    " AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 1",
    "mail_events_due",
)
INTERRUPTED = Query(
    "SELECT event_id, state FROM mail_events WHERE state IN ('summarizing', 'todo_sending')", "mail_events_due"
)
OWNER_ACTION = Query(
    "SELECT * FROM owner_actions WHERE owner = ? AND action_request_id = ?", "sqlite_autoindex_owner_actions_1"
)
