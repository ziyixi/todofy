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

# task-intent-v1 (core/intents.py): a failed intent's text 30 days after it failed (the proposer's
# retry brings it back with the same hash), then every finished intent 400 days after its last
# change, tasks first; an intent goes once none of its tasks is left, so no task row is orphaned.
EXPIRE_FAILED_INTENT_TEXT = Query(
    "UPDATE task_intents SET payload_json = NULL WHERE rowid IN (SELECT rowid FROM task_intents"
    " WHERE state = 'failed' AND updated_at < ? AND payload_json IS NOT NULL LIMIT ?)",
    "task_intents_updated",
)
EXPIRE_INTENT_TASKS = Query(
    "DELETE FROM task_intent_tasks WHERE rowid IN (SELECT t.rowid FROM task_intents AS i"
    " JOIN task_intent_tasks AS t ON t.source = i.source AND t.intent_id = i.intent_id"
    " WHERE i.state IN ('created', 'failed') AND i.updated_at < ? LIMIT ?)",
    "task_intents_updated",
)
EXPIRE_INTENTS = Query(
    "DELETE FROM task_intents WHERE rowid IN (SELECT rowid FROM task_intents AS i"
    " WHERE state IN ('created', 'failed') AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM task_intent_tasks AS t"
    " WHERE t.source = i.source AND t.intent_id = i.intent_id) LIMIT ?)",
    "task_intents_updated",
)
