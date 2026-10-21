"""D1 statements of the Mail entry (runtime/mail.py; proto/todofy/mail/v1/mail_service.proto).

Pending mail is a summaries row still awaiting a decision, indexed by created_at and event_id. Its task link is set
once Tasks converted it (or before the native cutover, by the task an older release created). List pages return only
the brief and its 600-character fallback; the full text is read for one chosen mail.
"""

from ..mailbox import BRIEF_SOURCE_CHARS
from . import Query

NATIVE_PENDING = "imported = 0 AND triaged_at IS NULL"
# What a MailItem is made of; the received time is the event's, else the summary's (an imported row has no event).
_ITEM = (
    "s.event_id,s.created_at,s.subject,s.task_id,s.triaged_at,s.imported,s.brief,"
    f" substr(s.summary,1,{BRIEF_SOURCE_CHARS}) AS head,s.summary<>'' AS has_summary,"
    " coalesce(e.created_at,s.created_at) AS received_at"
)

NATIVE_ITEMS = Query(
    f"SELECT {_ITEM}"
    " FROM summaries s LEFT JOIN mail_events e ON e.source_id=? AND e.event_id=s.event_id"
    f" WHERE s.{NATIVE_PENDING} AND (s.created_at,s.event_id)<(?,?)"
    " ORDER BY s.created_at DESC,s.event_id DESC LIMIT ?",
    "summaries_pending",
)
# One mail by its ID, pending or not, with its full summary.
ITEM = Query(
    f"SELECT {_ITEM},s.summary FROM summaries s LEFT JOIN mail_events e ON e.source_id=? AND e.event_id=s.event_id"
    " WHERE s.event_id=?",
    "sqlite_autoindex_summaries_1",
)
NATIVE_COUNT = Query(
    f"SELECT count(*) AS n FROM summaries INDEXED BY summaries_pending WHERE {NATIVE_PENDING}",
    "summaries_pending",
)
# Pending mail that arrived in a window (bind its start and end): the morning brief's carryover pool without its cap.
PENDING_BETWEEN = Query(
    f"SELECT count(*) AS n FROM summaries INDEXED BY summaries_pending"
    f" WHERE created_at > ? AND created_at <= ? AND {NATIVE_PENDING}",
    "summaries_pending",
)
# Compare-and-set on the pending mail as it was read: bind the task, the time, the category, the event and the task
# link read with its etag (the only part of the etag that can change while the mail is pending).
MARK_CONVERTED = Query(
    f"UPDATE summaries SET task_id=?,triaged_at=?,category_id=? WHERE event_id=? AND task_id=? AND {NATIVE_PENDING}",
    "sqlite_autoindex_summaries_1",
)
FORGET_EVENTS = Query(
    f"DELETE FROM summaries WHERE event_id IN (SELECT value FROM json_each(?)) AND {NATIVE_PENDING}",
    "sqlite_autoindex_summaries_1",
)
EXISTING_EVENTS = Query(
    "SELECT event_id FROM summaries WHERE event_id IN (SELECT value FROM json_each(?))",
    "sqlite_autoindex_summaries_1",
)

# event_transitions is never cleaned. Its primary-key cursor advances across every transition, including ones that
# have no native pending summary. LIMIT is applied before joining, so filtering cannot turn one poll into a scan.
READY_HEAD = Query("SELECT coalesce(max(id),0) AS id FROM event_transitions", "rowid")
READY_PAGE = Query(
    "WITH scanned AS MATERIALIZED ("
    " SELECT id,event_id,to_state FROM event_transitions WHERE id > ? ORDER BY id LIMIT 50"
    ") SELECT t.id,s.event_id,s.created_at FROM scanned t"
    " LEFT JOIN summaries s ON s.event_id=t.event_id AND t.to_state='complete'"
    f" AND s.{NATIVE_PENDING} ORDER BY t.id",
    "sqlite_autoindex_summaries_1",
    sort_allowed=True,
)
