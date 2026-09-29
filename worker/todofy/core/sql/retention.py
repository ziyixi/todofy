"""Daily cleanup (runtime/retention.py): each sweep selects a bounded batch of keys to delete."""

from . import Query

SUMMARIES_EXPIRED = Query(
    "SELECT event_id FROM summaries WHERE imported = 0 AND created_at < ? ORDER BY created_at LIMIT ?",
    "summaries_expiring",
)
REPORTS_EXPIRED = Query("SELECT kind, top_n, day FROM daily_reports WHERE day < ? LIMIT ?", "daily_reports_day")
OWNER_ACTIONS_EXPIRED = Query(
    "SELECT owner, action_request_id FROM owner_actions WHERE created_at < ? LIMIT ?", "owner_actions_created"
)
AUTH_FAILURES_EXPIRED = Query(
    "SELECT hour FROM auth_failures WHERE hour < ? LIMIT ?", "sqlite_autoindex_auth_failures_1"
)
LEGACY_TEXT_EXPIRED = Query(
    "SELECT event_id FROM legacy_mail_text WHERE expires_at IS NOT NULL AND expires_at <= ?"
    " ORDER BY expires_at LIMIT ?",
    "legacy_mail_text_expires",
)
