"""Daily cleanup (runtime/retention.py): each statement deletes one bounded batch.

Bind the cutoff, then the batch size. The inner select walks the named index;
the outer delete then hits each row by rowid. ``mail_events`` is never cleaned:
it is the webhook dedupe ledger.
"""

from . import Query

EXPIRE_SUMMARIES = Query(
    "DELETE FROM summaries WHERE rowid IN"
    " (SELECT rowid FROM summaries WHERE imported = 0 AND created_at < ? ORDER BY created_at LIMIT ?)",
    "summaries_expiring",
)
EXPIRE_REPORTS = Query(
    "DELETE FROM daily_reports WHERE rowid IN (SELECT rowid FROM daily_reports WHERE day < ? LIMIT ?)",
    "daily_reports_day",
)
EXPIRE_OWNER_ACTIONS = Query(
    "DELETE FROM owner_actions WHERE rowid IN (SELECT rowid FROM owner_actions WHERE created_at < ? LIMIT ?)",
    "owner_actions_created",
)
EXPIRE_AUTH_FAILURES = Query(
    "DELETE FROM auth_failures WHERE rowid IN (SELECT rowid FROM auth_failures WHERE hour < ? LIMIT ?)",
    "sqlite_autoindex_auth_failures_1",
)
# The cutoff is "now": expires_at is the moment the text may go.
EXPIRE_LEGACY_TEXT = Query(
    "DELETE FROM legacy_mail_text WHERE rowid IN (SELECT rowid FROM legacy_mail_text"
    " WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?)",
    "legacy_mail_text_expires",
)
# LEGACY_TEXT_RETENTION_DAYS > 0: the cutoff is now minus that many days.
EXPIRE_LEGACY_TEXT_OLD = Query(
    "DELETE FROM legacy_mail_text WHERE rowid IN"
    " (SELECT rowid FROM legacy_mail_text WHERE created_at < ? ORDER BY created_at LIMIT ?)",
    "legacy_mail_text_created",
)
# The GTD ledger (docs/gtd-features.md §5): raw snapshot rows 14 days, snapshots and aggregates 120 days,
# reviews 400 days. Bind the first day (or ISO week) to keep, then the batch size.
EXPIRE_GTD_TASKS = Query(
    "DELETE FROM gtd_snapshot_tasks WHERE rowid IN (SELECT rowid FROM gtd_snapshot_tasks WHERE day < ? LIMIT ?)",
    "sqlite_autoindex_gtd_snapshot_tasks_1",
)
EXPIRE_GTD_SNAPSHOTS = Query(
    "DELETE FROM gtd_snapshots WHERE rowid IN (SELECT rowid FROM gtd_snapshots WHERE day < ? LIMIT ?)",
    "sqlite_autoindex_gtd_snapshots_1",
)
EXPIRE_GTD_DAILY = Query(
    "DELETE FROM gtd_daily WHERE rowid IN (SELECT rowid FROM gtd_daily WHERE day < ? LIMIT ?)",
    "sqlite_autoindex_gtd_daily_1",
)
EXPIRE_GTD_REVIEWS = Query(
    "DELETE FROM gtd_reviews WHERE rowid IN (SELECT rowid FROM gtd_reviews WHERE week < ? LIMIT ?)",
    "sqlite_autoindex_gtd_reviews_1",
)
