"""Ledger writes and scheduler reads (runtime/ledger.py, runtime/coordinator.py).

Rows that depend on a state change (its transition, the summaries row, the
owner action) are INSERT ... SELECT from the event at its new version, guarded
by ``changes() = 1``: in one batch each runs only when the statement just before
it changed exactly one row, so they are written exactly when the compare-and-set
above them won. The version alone is not enough: a writer one version behind
would still match the row that another writer has just moved to that version.
"""

from ..vocab import EventState
from . import DUE, Query, sql_list

# Due states that need no Todoist call (used while the Todoist stage is paused).
DUE_WITHOUT_TODOIST = f"state IN ({sql_list([EventState.PENDING, EventState.TODO_CREATED])})"

EVENT = Query("SELECT * FROM mail_events WHERE source_id = ? AND event_id = ?", "sqlite_autoindex_mail_events_1")

INGEST = Query(
    "INSERT INTO mail_events"
    " (source_id, event_id, payload_hash, payload, state, next_attempt_at, created_at, updated_at)"
    " VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING",
    "sqlite_autoindex_mail_events_1",
)
# changes() is the row count of the INGEST just before it in the same batch.
ARRIVAL = Query(
    "INSERT INTO event_transitions (event_id, at, from_state, to_state, error_code, actor)"
    " SELECT event_id, ?, NULL, 'pending', '', 'worker' FROM mail_events"
    " WHERE source_id = ? AND event_id = ? AND changes() = 1",
    "sqlite_autoindex_mail_events_1",
)
INGEST_HASH = Query(
    "SELECT payload_hash FROM mail_events WHERE source_id = ? AND event_id = ?",
    "sqlite_autoindex_mail_events_1",
)

# A NULL binding keeps the column; the payload flag (1) drops the mail body.
STATE_CAS = Query(
    "UPDATE mail_events SET state = ?, version = version + 1, updated_at = ?,"
    " payload = iif(?, NULL, payload),"
    " summary = coalesce(?, summary), summary_model = coalesce(?, summary_model),"
    " todo_body = coalesce(?, todo_body), todoist_request_id = coalesce(?, todoist_request_id),"
    " task_id = coalesce(?, task_id), attempt_count = coalesce(?, attempt_count),"
    " crashes = coalesce(?, crashes), next_attempt_at = coalesce(?, next_attempt_at),"
    " last_error_code = coalesce(?, last_error_code)"
    " WHERE source_id = ? AND event_id = ? AND state = ? AND version = ?",
    "sqlite_autoindex_mail_events_1",
)
TRANSITION = Query(
    "INSERT INTO event_transitions (event_id, at, from_state, to_state, error_code, actor)"
    " SELECT event_id, ?, ?, ?, ?, ? FROM mail_events"
    " WHERE source_id = ? AND event_id = ? AND version = ? AND changes() = 1",
    "sqlite_autoindex_mail_events_1",
)
# Runs right after TRANSITION (changes() is its insert).
COMPLETE_SUMMARY = Query(
    "INSERT INTO summaries (event_id, created_at, subject, summary, model, task_id)"
    " SELECT event_id, ?, ?, ?, ?, ? FROM mail_events"
    " WHERE source_id = ? AND event_id = ? AND version = ? AND state = 'complete' AND changes() = 1"
    " ON CONFLICT (event_id) DO NOTHING",
    "sqlite_autoindex_mail_events_1",
)
LATEST_TRANSITION = Query(
    "SELECT from_state, to_state, actor FROM event_transitions WHERE event_id = ? ORDER BY at DESC, id DESC LIMIT 1",
    "event_transitions_event",
)

NEXT_DUE = Query(
    f"SELECT * FROM mail_events WHERE {DUE} AND next_attempt_at <= ? ORDER BY created_at LIMIT 1",
    "mail_events_due",
    sort_allowed=True,
)
NEXT_DUE_WITHOUT_TODOIST = Query(
    f"SELECT * FROM mail_events WHERE {DUE_WITHOUT_TODOIST} AND next_attempt_at <= ? ORDER BY created_at LIMIT 1",
    "mail_events_due",
    sort_allowed=True,
)
NEXT_WAKE = Query(f"SELECT min(next_attempt_at) AS at FROM mail_events WHERE {DUE}", "mail_events_due")
NEXT_WAKE_WITHOUT_TODOIST = Query(
    f"SELECT min(next_attempt_at) AS at FROM mail_events WHERE {DUE_WITHOUT_TODOIST}", "mail_events_due"
)
# next_attempt_at = 0 means no lookup is scheduled.
LOOKUP_DUE = Query(
    "SELECT * FROM mail_events WHERE state = 'todo_unknown' AND next_attempt_at > 0"
    " AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 1",
    "mail_events_due",
)
NEXT_LOOKUP = Query(
    "SELECT min(next_attempt_at) AS at FROM mail_events WHERE state = 'todo_unknown' AND next_attempt_at > 0",
    "mail_events_due",
)
# Only one step runs at a time, so at most one row is ever caught mid-call.
INTERRUPTED = Query(
    "SELECT * FROM mail_events WHERE state IN ('summarizing', 'todo_sending') LIMIT 10", "mail_events_due"
)

OWNER_ACTION = Query(
    "SELECT request_hash, result_ref, http_status FROM owner_actions WHERE owner = ? AND action_request_id = ?",
    "sqlite_autoindex_owner_actions_1",
)
# Recorded together with the reconcile transition it belongs to, right after TRANSITION.
ACTION_WITH_TRANSITION = Query(
    "INSERT INTO owner_actions"
    " (owner, action_request_id, kind, event_id, request_hash, result_ref, http_status, created_at)"
    " SELECT ?, ?, ?, event_id, ?, event_id, 200, ? FROM mail_events"
    " WHERE source_id = ? AND event_id = ? AND version = ? AND changes() = 1",
    "sqlite_autoindex_mail_events_1",
)
ACTION_CLAIM = Query(
    "INSERT INTO owner_actions (owner, action_request_id, kind, request_hash, created_at)"
    " VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    "sqlite_autoindex_owner_actions_1",
)
ACTION_FINISH = Query(
    "UPDATE owner_actions SET result_ref = ?, http_status = ? WHERE owner = ? AND action_request_id = ?",
    "sqlite_autoindex_owner_actions_1",
)
