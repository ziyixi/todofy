"""The daily owner reminder (runtime/reminder.py). Canary events are never reminded of."""

from . import ACTIVE, ATTENTION, REAL_MAIL, Query

REMINDER_DAY = Query(
    "SELECT state, attempts, next_attempt_at, subject, body FROM mail_reminders WHERE day = ?",
    "sqlite_autoindex_mail_reminders_1",
)
REMINDER_PAGE = Query(
    "SELECT day, state, task_id, attention_count, attempts, next_attempt_at, last_error_code, imported,"
    " created_at, updated_at FROM mail_reminders WHERE day < ? ORDER BY day DESC LIMIT ?",
    "sqlite_autoindex_mail_reminders_1",
)
ATTENTION_COUNT = Query(
    f"SELECT count(*) AS n FROM mail_events WHERE source_id = ? AND {ACTIVE} AND {ATTENTION} AND {REAL_MAIL}",
    "mail_events_by_state",
)
# Oldest first, as the reminder text lists them.
ATTENTION_ROWS = Query(
    f"SELECT event_id, state, last_error_code, created_at FROM mail_events"
    f" WHERE source_id = ? AND {ACTIVE} AND {ATTENTION} AND {REAL_MAIL} ORDER BY created_at, event_id LIMIT ?",
    "mail_events_active",
)

# Claims the day before Todoist is called; ops_count is the number of ops items the body lists.
CLAIM_DAY = Query(
    "INSERT INTO mail_reminders (day, state, subject, body, attention_count, ops_count, created_at, updated_at)"
    " VALUES (?, 'sending', ?, ?, ?, ?, ?, ?) ON CONFLICT (day) DO NOTHING",
    "sqlite_autoindex_mail_reminders_1",
)
# Re-claims a failed day with its frozen subject and body, so the retry keeps its X-Request-Id.
CLAIM_RETRY = Query(
    "UPDATE mail_reminders SET state = 'sending', updated_at = ?"
    " WHERE day = ? AND state = 'failed' AND attempts = ? AND next_attempt_at <= ?",
    "sqlite_autoindex_mail_reminders_1",
)
FINISH = Query(
    "UPDATE mail_reminders SET state = ?, task_id = ?, attempts = attempts + 1, next_attempt_at = ?,"
    " last_error_code = ?, updated_at = ? WHERE day = ? AND state = 'sending'",
    "sqlite_autoindex_mail_reminders_1",
)
# A day still 'sending' when no call is running was interrupted mid-call.
RECOVER_SENDING = Query(
    "UPDATE mail_reminders SET state = 'unknown', attempts = attempts + 1, next_attempt_at = 0,"
    " last_error_code = ?, updated_at = ? WHERE state = 'sending'",
    "mail_reminders_sending",
)
