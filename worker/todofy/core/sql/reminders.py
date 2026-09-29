"""The daily owner reminder (runtime/reminder.py)."""

from . import Query

REMINDER_DAY = Query("SELECT * FROM mail_reminders WHERE day = ?", "sqlite_autoindex_mail_reminders_1")
REMINDER_PAGE = Query(
    "SELECT day FROM mail_reminders WHERE day < ? ORDER BY day DESC LIMIT ?", "sqlite_autoindex_mail_reminders_1"
)
REMINDER_SENDING = Query("SELECT day FROM mail_reminders WHERE state = 'sending'", "mail_reminders_sending")
