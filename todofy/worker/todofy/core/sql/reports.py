"""Daily reports and the newsletter endpoints (runtime/reports.py).

The two upserts name the unique key their conflict clause hits.
"""

from . import Query

REPORT_WINDOW = Query(
    "SELECT summary FROM summaries WHERE created_at > ? AND created_at <= ? ORDER BY created_at LIMIT ?",
    "summaries_created",
)
# The morning brief's carryover (docs/gtd-features.md §3): the newest ok snapshot finished since a time
# (bind the first and last day to consider, then that time).
LATEST_OK_SNAPSHOT = Query(
    "SELECT day, finished_at FROM gtd_snapshots WHERE day >= ? AND day <= ? AND status = 'ok'"
    " AND finished_at >= ? ORDER BY day DESC LIMIT 1",
    "sqlite_autoindex_gtd_snapshots_1",
)
# Mail tasks from before the 24 h window (bind its start and end) still open in that snapshot (bind its
# day), newest first, at most the cap: walks summaries_created plus one primary-key probe each.
CARRYOVER = Query(
    "SELECT summary, created_at FROM summaries WHERE created_at > ? AND created_at <= ? AND task_id <> ''"
    " AND EXISTS (SELECT 1 FROM gtd_snapshot_tasks g WHERE g.day = ? AND g.task_id = summaries.task_id)"
    " ORDER BY created_at DESC LIMIT ?",
    "summaries_created",
)
LATEST_REPORT = Query(
    "SELECT payload_json, status, computed_at FROM daily_reports"
    " WHERE kind = ? AND top_n = ? ORDER BY day DESC LIMIT 1",
    "sqlite_autoindex_daily_reports_1",
)
AUTH_FAILURES_HOUR = Query("SELECT count FROM auth_failures WHERE hour = ?", "sqlite_autoindex_auth_failures_1")

# A recompute on the same UTC day replaces the row.
STORE_REPORT = Query(
    "INSERT INTO daily_reports (kind, top_n, day, status, payload_json, model, task_count,"
    " window_start, window_end, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    " ON CONFLICT (kind, top_n, day) DO UPDATE SET status = excluded.status,"
    " payload_json = excluded.payload_json, model = excluded.model, task_count = excluded.task_count,"
    " window_start = excluded.window_start, window_end = excluded.window_end, computed_at = excluded.computed_at",
    "sqlite_autoindex_daily_reports_1",
)
COUNT_AUTH_FAILURE = Query(
    "INSERT INTO auth_failures (hour, count) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET count = count + 1",
    "sqlite_autoindex_auth_failures_1",
)
