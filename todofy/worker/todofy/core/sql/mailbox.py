"""D1 statements of the Mailbox (runtime/plus_mail.py, runtime/mail_briefs.py; docs/todoist-plus.md, "Mailbox").

Native entries are pending summaries, indexed by created_at and event_id. A task link is optional until explicit
conversion. List pages return only the brief and its 600-character fallback; full text is read for one chosen
entry's detail or conversion. Older task-ID lookups use the existing summaries_task partial index.
"""

from ..mailbox import BRIEF_SOURCE_CHARS
from . import Query

_MAIL = "s.task_id = j.value AND s.task_id <> '' AND s.imported = 0"
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

# Bind the task IDs (JSON), then the source ID: the received time is the ledger row's, and the completed summary's
# own while that row is out of reach (a restore of summaries alone, say).
ITEMS = Query(
    "SELECT s.event_id, s.task_id, coalesce(e.created_at, s.created_at) AS received_at, s.brief,"
    f" substr(s.summary, 1, {BRIEF_SOURCE_CHARS}) AS head, s.summary <> '' AS has_summary"
    f" FROM json_each(?) AS j JOIN summaries AS s ON {_MAIL}"
    " LEFT JOIN mail_events AS e ON e.source_id = ? AND e.event_id = s.event_id",
    "summaries_task",
)
# The tasks among those bound that are mail, IDs only (DeleteMailItems' check).
MAIL_TASKS = Query(f"SELECT s.task_id FROM json_each(?) AS j JOIN summaries AS s ON {_MAIL}", "summaries_task")
# The tasks among those bound that wait for another task or that another waits for: a dependency the owner made.
# Bind task IDs (JSON), then the current provider. CROSS JOIN keeps the bound IDs driving, so plan_tasks is
# searched by its unique key and never walked.
LINKED_TASKS = Query(
    "SELECT j.value AS task_id FROM json_each(?) AS j CROSS JOIN plan_tasks AS t"
    " ON t.provider = ? AND t.external_id = j.value"
    " WHERE EXISTS (SELECT 1 FROM plan_edges AS e WHERE e.task_id = t.id)"
    " OR EXISTS (SELECT 1 FROM plan_edges AS e WHERE e.prerequisite_id = t.id)",
    "sqlite_autoindex_plan_tasks_1",
)
SUMMARY = Query("SELECT summary FROM summaries WHERE event_id = ?", "sqlite_autoindex_summaries_1")
# Delete all's last step: the summaries of the mail it deleted (subject, summary and brief); mail_events, the
# ledger of IDs and states, stays.
FORGET = Query(
    "DELETE FROM summaries WHERE task_id IN (SELECT j.value FROM json_each(?) AS j) AND task_id <> '' AND imported = 0",
    "summaries_task",
)

# The one-time brief backfill: the mail among the bound tasks whose brief was never derived.
UNBRIEFED = Query(
    f"SELECT s.event_id FROM json_each(?) AS j JOIN summaries AS s ON {_MAIL}"
    " WHERE s.brief IS NULL AND s.summary <> ''",
    "summaries_task",
)
# What the model reads for one brief: the subject and the summary's first 4,000 characters.
BRIEF_INPUT = Query(
    "SELECT subject, substr(summary, 1, 4000) AS summary, brief FROM summaries WHERE event_id = ?",
    "sqlite_autoindex_summaries_1",
)
# Never over a brief already there: the backfill's answer loses to one stored meanwhile.
SAVE_BRIEF = Query(
    "UPDATE summaries SET brief = ? WHERE event_id = ? AND brief IS NULL", "sqlite_autoindex_summaries_1"
)
