"""Daily reports and the newsletter endpoints (runtime/reports.py)."""

from . import Query

REPORT_WINDOW = Query(
    "SELECT summary FROM summaries WHERE created_at > ? AND created_at <= ? ORDER BY created_at",
    "summaries_created",
)
LATEST_REPORT = Query(
    "SELECT payload_json, status, computed_at FROM daily_reports"
    " WHERE kind = ? AND top_n = ? ORDER BY day DESC LIMIT 1",
    "sqlite_autoindex_daily_reports_1",
)
AUTH_FAILURES_HOUR = Query("SELECT count FROM auth_failures WHERE hour = ?", "sqlite_autoindex_auth_failures_1")
