"""task-intent-v1 ledger (runtime/intents.py): task_intents and task_intent_tasks.

Recording is one batch: the intent row (only while its source is under the daily limit), its task
rows (only when that insert won: ``changes() = 1`` is the row count of the statement just before),
and the row as stored, so a replay, a concurrent twin and the daily limit are told apart without
another round trip. Every other write names its row by primary key and the state it expects.
"""

from . import Query

INTENT = Query(
    "SELECT * FROM task_intents WHERE source = ? AND intent_id = ?",
    "sqlite_autoindex_task_intents_1",
)
TASKS = Query(
    "SELECT * FROM task_intent_tasks WHERE source = ? AND intent_id = ? ORDER BY n",
    "sqlite_autoindex_task_intent_tasks_1",
)

# Bind: source, intent_id, sha256, mode, tasks_total, payload_json, next_attempt_at, created_at,
# updated_at, then source, the UTC day's start and the limit for the count.
RECORD = Query(
    "INSERT INTO task_intents (source, intent_id, payload_sha256, mode, tasks_total, tasks_created, state,"
    " error_code, payload_json, next_attempt_at, created_at, updated_at)"
    " SELECT ?, ?, ?, ?, ?, 0, 'pending', '', ?, ?, ?, ?"
    " WHERE (SELECT count(*) FROM task_intents WHERE source = ? AND created_at >= ?) < ?"
    " ON CONFLICT DO NOTHING",
    "task_intents_created",
)
# Bind: source, intent_id, next_attempt_at, started_at, updated_at, then a JSON array of [n, request_id].
RECORD_TASKS = Query(
    "INSERT INTO task_intent_tasks (source, intent_id, n, request_id, state, attempts, next_attempt_at,"
    " error_code, started_at, updated_at)"
    " SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), 'pending', 0, ?, '', ?, ?"
    " FROM json_each(?) WHERE changes() = 1",
    "sqlite_autoindex_task_intent_tasks_1",
)

# The proposer retried a failed intent: its unfinished tasks run again (unknown ones are looked up
# first), with a new retry window. The payload comes back if retention had dropped it (same hash).
REQUEUE = Query(
    "UPDATE task_intents SET state = 'pending', error_code = '', next_attempt_at = ?, updated_at = ?,"
    " payload_json = coalesce(payload_json, ?) WHERE source = ? AND intent_id = ? AND state = 'failed'",
    "sqlite_autoindex_task_intents_1",
)
# Runs right after REQUEUE (changes() is its update).
REQUEUE_TASKS = Query(
    "UPDATE task_intent_tasks SET"
    " state = iif(state = 'failed' AND error_code = 'todoist_result_unknown', 'recheck', 'pending'),"
    " attempts = 0, next_attempt_at = ?, error_code = '', started_at = ?, updated_at = ?"
    " WHERE source = ? AND intent_id = ? AND state IN ('failed', 'pending') AND changes() = 1",
    "sqlite_autoindex_task_intent_tasks_1",
)

NEXT_DUE = Query(
    "SELECT * FROM task_intents WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 1",
    "task_intents_due",
)
NEXT_WAKE = Query("SELECT min(next_attempt_at) AS at FROM task_intents WHERE state = 'pending'", "task_intents_due")

# Bind: the new state, updated_at, then the key and the state the step read.
TASK_STATE = Query(
    "UPDATE task_intent_tasks SET state = ?, updated_at = ? WHERE source = ? AND intent_id = ? AND n = ? AND state = ?",
    "sqlite_autoindex_task_intent_tasks_1",
)
# Bind: state, attempts, next_attempt_at, todoist_id, error_code, updated_at, then the key and the
# state the step read.
TASK_RESULT = Query(
    "UPDATE task_intent_tasks SET state = ?, attempts = ?, next_attempt_at = ?, todoist_id = ?, error_code = ?,"
    " updated_at = ? WHERE source = ? AND intent_id = ? AND n = ? AND state = ?",
    "sqlite_autoindex_task_intent_tasks_1",
)
# The intent after a step; a created intent drops its text. Bind: state, tasks_created, error_code,
# next_attempt_at, updated_at, the state again (for the payload), then the key.
INTENT_STEP = Query(
    "UPDATE task_intents SET state = ?, tasks_created = ?, error_code = ?, next_attempt_at = ?, updated_at = ?,"
    " payload_json = iif(? = 'created', NULL, payload_json)"
    " WHERE source = ? AND intent_id = ? AND state = 'pending'",
    "sqlite_autoindex_task_intents_1",
)

# ops-v1 status() counters: pending intents, and intents failed in the last 7 days (bind that cutoff).
COUNTS = Query(
    "SELECT coalesce(sum(state = 'pending'), 0) AS pending,"
    " coalesce(sum(state = 'failed' AND updated_at >= ?), 0) AS failed"
    " FROM task_intents WHERE state IN ('pending', 'failed')",
    "task_intents_updated",
)
