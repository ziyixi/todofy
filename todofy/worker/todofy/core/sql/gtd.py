"""The GTD ledger (runtime/gtd.py): the daily snapshot, its aggregates and the weekly review.

A day's snapshot holds at most MAX_SNAPSHOT_ROWS rows (10 pages of 200), so every read of one day is
bounded by the primary key's ``day`` prefix. Nothing here selects task text: the tables have none.
"""

from . import Query

SNAPSHOT_INDEX = "sqlite_autoindex_gtd_snapshots_1"
TASKS_INDEX = "sqlite_autoindex_gtd_snapshot_tasks_1"
DAILY_INDEX = "sqlite_autoindex_gtd_daily_1"
REVIEWS_INDEX = "sqlite_autoindex_gtd_reviews_1"

# A new attempt on a day replaces that day's snapshot: its row starts over and its task rows are cleared.
SNAPSHOT_START = Query(
    "INSERT INTO gtd_snapshots (day, status, started_at) VALUES (?, 'collecting', ?)"
    " ON CONFLICT (day) DO UPDATE SET status = 'collecting', task_count = 0, skipped = 0, pages = 0,"
    " error_code = '', started_at = excluded.started_at, finished_at = NULL",
    SNAPSHOT_INDEX,
)
# Bind the day, then MAX_SNAPSHOT_ROWS.
CLEAR_DAY = Query(
    "DELETE FROM gtd_snapshot_tasks WHERE rowid IN (SELECT rowid FROM gtd_snapshot_tasks WHERE day = ? LIMIT ?)",
    TASKS_INDEX,
)
# One page (at most 200 rows) in one statement: bind the day, then a JSON array of core.gtd.snapshot_row
# objects. A task Todoist lists twice across pages keeps its later row.
WRITE_PAGE = Query(
    "INSERT INTO gtd_snapshot_tasks (day, task_id, project_id, parent_id, labels, priority, due_date, due_at,"
    " due_recurring, deadline_date, added_at, checked, content_hmac)"
    " SELECT ?, json_extract(value, '$.task_id'), json_extract(value, '$.project_id'),"
    " json_extract(value, '$.parent_id'), json_extract(value, '$.labels'), json_extract(value, '$.priority'),"
    " json_extract(value, '$.due_date'), json_extract(value, '$.due_at'), json_extract(value, '$.due_recurring'),"
    " json_extract(value, '$.deadline_date'), json_extract(value, '$.added_at'), json_extract(value, '$.checked'),"
    " json_extract(value, '$.content_hmac') FROM json_each(?) WHERE true"
    " ON CONFLICT (day, task_id) DO UPDATE SET project_id = excluded.project_id, parent_id = excluded.parent_id,"
    " labels = excluded.labels, priority = excluded.priority, due_date = excluded.due_date,"
    " due_at = excluded.due_at, due_recurring = excluded.due_recurring, deadline_date = excluded.deadline_date,"
    " added_at = excluded.added_at, checked = excluded.checked, content_hmac = excluded.content_hmac",
    TASKS_INDEX,
)
SNAPSHOT_FINISH = Query(
    "UPDATE gtd_snapshots SET status = ?, task_count = ?, skipped = ?, pages = ?, error_code = ?, finished_at = ?"
    " WHERE day = ?",
    SNAPSHOT_INDEX,
)
SNAPSHOT_DAY = Query("SELECT day, status, finished_at FROM gtd_snapshots WHERE day = ?", SNAPSHOT_INDEX)
# The aggregate reads the day back: bind the day, then MAX_SNAPSHOT_ROWS.
SNAPSHOT_ROWS = Query(
    "SELECT project_id, parent_id, priority, due_date, due_at, due_recurring, deadline_date, added_at"
    " FROM gtd_snapshot_tasks WHERE day = ? LIMIT ?",
    TASKS_INDEX,
)
# Tasks in yesterday's snapshot (first day) missing from today's (second): completions plus deletions.
CLOSED_SINCE = Query(
    "SELECT count(*) AS n FROM gtd_snapshot_tasks y WHERE y.day = ?"
    " AND NOT EXISTS (SELECT 1 FROM gtd_snapshot_tasks t WHERE t.day = ? AND t.task_id = y.task_id)",
    TASKS_INDEX,
)
# Mail tasks of a window (bind its start and end) still open in the day's snapshot (bind the day):
# walks summaries_created (about 100 rows a day) plus one primary-key probe each.
MAIL_OPEN = Query(
    "SELECT count(*) AS n FROM summaries WHERE created_at > ? AND created_at <= ? AND task_id <> ''"
    " AND EXISTS (SELECT 1 FROM gtd_snapshot_tasks g WHERE g.day = ? AND g.task_id = summaries.task_id)",
    "summaries_created",
)
WRITE_DAILY = Query(
    "INSERT INTO gtd_daily (day, scope, open, age_0_7, age_8_14, age_15_30, age_31_plus, oldest_days, overdue,"
    " undated, created_7d, completed_7d, completed_source, closed_1d, mail_open, complete, computed_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    " ON CONFLICT (day, scope) DO UPDATE SET open = excluded.open, age_0_7 = excluded.age_0_7,"
    " age_8_14 = excluded.age_8_14, age_15_30 = excluded.age_15_30, age_31_plus = excluded.age_31_plus,"
    " oldest_days = excluded.oldest_days, overdue = excluded.overdue, undated = excluded.undated,"
    " created_7d = excluded.created_7d, completed_7d = excluded.completed_7d,"
    " completed_source = excluded.completed_source, closed_1d = excluded.closed_1d,"
    " mail_open = excluded.mail_open, complete = excluded.complete, computed_at = excluded.computed_at",
    DAILY_INDEX,
)
# Bind the first and last day (inclusive), then a row cap (two scopes a day).
DAILY_RANGE = Query(
    "SELECT day, scope, open, age_0_7, age_8_14, age_15_30, age_31_plus, oldest_days, overdue, undated,"
    " created_7d, completed_7d, completed_source, closed_1d, mail_open, complete, computed_at"
    " FROM gtd_daily WHERE day >= ? AND day <= ? ORDER BY day LIMIT ?",
    DAILY_INDEX,
)

# Weekly reviews. Weeks are 'YYYY-Www' and sort in time order.
REVIEW_WEEK = Query(
    "SELECT week, state, attempts, next_attempt_at, subject, body, project_id, task_id FROM gtd_reviews WHERE week = ?",
    REVIEWS_INDEX,
)
# Created reviews from a week on (bind it) that no completed list has shown done yet.
OPEN_REVIEWS = Query(
    "SELECT week, task_id FROM gtd_reviews WHERE week >= ? AND state = 'created' AND completed_at IS NULL"
    " AND task_id <> '' ORDER BY week LIMIT 8",
    REVIEWS_INDEX,
)
REVIEW_DONE = Query(
    "UPDATE gtd_reviews SET completed_at = ?, updated_at = ? WHERE week = ? AND task_id = ? AND completed_at IS NULL",
    REVIEWS_INDEX,
)
# Recent reviews, newest first (bind the first week and a cap): the last completion and the first review.
REVIEW_HISTORY = Query(
    "SELECT week, state, completed_at, created_at FROM gtd_reviews WHERE week >= ? ORDER BY week DESC LIMIT ?",
    REVIEWS_INDEX,
)
# Claims the week before Todoist is called, with the frozen title, body and project.
CLAIM_REVIEW = Query(
    "INSERT INTO gtd_reviews (week, state, project_id, subject, body, created_at, updated_at)"
    " VALUES (?, 'sending', ?, ?, ?, ?, ?) ON CONFLICT (week) DO NOTHING",
    REVIEWS_INDEX,
)
CLAIM_REVIEW_RETRY = Query(
    "UPDATE gtd_reviews SET state = 'sending', updated_at = ?"
    " WHERE week = ? AND state = 'failed' AND attempts = ? AND next_attempt_at <= ?",
    REVIEWS_INDEX,
)
FINISH_REVIEW = Query(
    "UPDATE gtd_reviews SET state = ?, task_id = ?, attempts = attempts + 1, next_attempt_at = ?,"
    " last_error_code = ?, updated_at = ? WHERE week = ? AND state = 'sending'",
    REVIEWS_INDEX,
)
# A week still 'sending' when no call is running was interrupted mid-call: never resent.
RECOVER_REVIEW = Query(
    "UPDATE gtd_reviews SET state = 'unknown', attempts = attempts + 1, next_attempt_at = 0,"
    " last_error_code = ?, updated_at = ? WHERE state = 'sending'",
    "gtd_reviews_sending",
)
