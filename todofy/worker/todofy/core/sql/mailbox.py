"""D1 statements of the Mailbox (runtime/plus_mail.py, runtime/mail_briefs.py; docs/todoist-plus.md, "Mailbox").

A mail item is the ``summaries`` row a completed Mail Hero event wrote: summaries keeps them (no time-based
deletion; the owner's Delete all removes the rows of the mail it deletes), so its task_id is the link from a task
to its mail. The lookups take the tasks the caller holds as one bound JSON array (at most 200 IDs) and walk the
partial index summaries_task, whose WHERE terms they repeat. No statement returns more of a summary than its brief
and first 600 characters, but for one mail's ReadMailSummary.
"""

from ..mailbox import BRIEF_SOURCE_CHARS
from . import Query

_MAIL = "s.task_id = j.value AND s.task_id <> '' AND s.imported = 0"

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
# CROSS JOIN keeps the bound IDs driving, so plan_tasks is searched by its unique key and never walked.
LINKED_TASKS = Query(
    "SELECT j.value AS task_id FROM json_each(?) AS j CROSS JOIN plan_tasks AS t"
    " ON t.provider = 'todoist' AND t.external_id = j.value"
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
