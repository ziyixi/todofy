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
