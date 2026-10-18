"""D1 statements of Mail (runtime/plus_mail.py; docs/planning-api.md, "Mail").

Native entries are pending summaries, indexed by created_at and event_id. A task link is optional until explicit
conversion. List pages return only the brief and its 600-character fallback; full text is read for one chosen
entry's detail or conversion.
"""

from ..mailbox import BRIEF_SOURCE_CHARS
from . import Query

NATIVE_PENDING = "imported = 0 AND triaged_at IS NULL"

NATIVE_ITEMS = Query(
    "SELECT s.event_id,s.created_at,s.subject,s.task_id,s.triaged_at,s.brief,"
    f" substr(s.summary,1,{BRIEF_SOURCE_CHARS}) AS head,s.summary<>'' AS has_summary,"
    " coalesce(e.created_at,s.created_at) AS received_at"
    " FROM summaries s LEFT JOIN mail_events e ON e.source_id=? AND e.event_id=s.event_id"
    f" WHERE s.{NATIVE_PENDING} AND (s.created_at,s.event_id)<(?,?)"
    " ORDER BY s.created_at DESC,s.event_id DESC LIMIT ?",
    "summaries_pending",
)
NATIVE_ITEM = Query(f"SELECT * FROM summaries WHERE event_id=? AND {NATIVE_PENDING}", "sqlite_autoindex_summaries_1")
NATIVE_COUNT = Query(
    f"SELECT count(*) AS n FROM summaries INDEXED BY summaries_pending WHERE {NATIVE_PENDING}",
    "summaries_pending",
)
TRIAGE = Query(
    f"UPDATE summaries SET task_id=?,triaged_at=?,category_id=? WHERE event_id=? AND {NATIVE_PENDING}",
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

SUMMARY = Query("SELECT summary FROM summaries WHERE event_id = ?", "sqlite_autoindex_summaries_1")
