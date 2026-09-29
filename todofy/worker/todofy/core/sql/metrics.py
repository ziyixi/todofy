"""Daily metrics (runtime/metrics.py): the transition walk, the day's write and the owner API read.

event_transitions.id is an INTEGER PRIMARY KEY written by the single coordinator
in time order, so the day's transitions are a rowid range: the walk pages from a
cursor kept in the object's storage and reads only rows it has not counted yet.
"""

from . import Query

# The walk's starting point when the object has no cursor (first run, lost storage, or a
# database the cursor does not belong to).
LAST_TRANSITION = Query("SELECT coalesce(max(id), 0) AS id FROM event_transitions", "rowid")
# The row a cursor points at. The object keeps its event_id and time next to the cursor: ids
# are not AUTOINCREMENT, so a restored database (backup restore or D1 Time Travel) reuses ids
# with other rows, and a cursor whose row changed or vanished must not be walked on from.
CURSOR_ROW = Query("SELECT event_id, at FROM event_transitions WHERE id = ?", "rowid")
# Bind the source, the cursor (last counted id), then the page size. The event is looked up
# only for arrivals and completions, the transitions that count: a completion's end-to-end
# latency is at - received_at, and canary events (canary_run_id set) count as neither.
TRANSITIONS_AFTER = Query(
    "SELECT t.id, t.event_id, t.at, t.from_state, t.to_state, e.created_at AS received_at, e.canary_run_id"
    " FROM event_transitions t LEFT JOIN mail_events e"
    " ON (t.from_state IS NULL OR t.to_state = 'complete') AND e.source_id = ? AND e.event_id = t.event_id"
    " WHERE t.id > ? ORDER BY t.id LIMIT ?",
    "sqlite_autoindex_mail_events_1",
)
# One finished day in one statement: bind the day, then a JSON object {key: value}.
# A rewrite of the same day (after a lost acknowledgement) replaces its values.
WRITE_DAY = Query(
    "INSERT INTO daily_metrics (day, key, value) SELECT ?, key, value FROM json_each(?) WHERE true"
    " ON CONFLICT (day, key) DO UPDATE SET value = excluded.value",
    "sqlite_autoindex_daily_metrics_1",
)
# Bind the first day to keep, then the batch size.
EXPIRE_DAYS = Query(
    "DELETE FROM daily_metrics WHERE rowid IN (SELECT rowid FROM daily_metrics WHERE day < ? LIMIT ?)",
    "sqlite_autoindex_daily_metrics_1",
)
# Bind the first and the last day (inclusive), then a row cap.
DAYS = Query(
    "SELECT day, key, value FROM daily_metrics WHERE day >= ? AND day <= ? ORDER BY day, key LIMIT ?",
    "sqlite_autoindex_daily_metrics_1",
)
