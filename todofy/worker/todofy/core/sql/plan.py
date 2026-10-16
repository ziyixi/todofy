"""D1 statements of the planning store (runtime/plan_store.py, migrations/0007_plan_store.sql).

``VERIFY`` is the owner's check after a restore or a migration (PlusService.VerifyPlanStore): one statement that
counts every row of the six plan tables, so it is a deliberate whole-table read rather than a ``Query``
constant (a count names no index). Every one of these tables is small by design (core/plan.py limits, a few
thousand task identities a year), and only the owner calls it. tests/unit/test_plan_store.py checks that its plan
reads no other table and that each count finds what it should.

Dependencies are plan_edges rows between plan_tasks IDs; every statement here takes and answers the task store's
own IDs ((provider, external_id), bound as two values), so callers never see Todofy's. ``EDGES`` is the other
whole-table read: every dependency (at most MAX_EDGES), for a full Plan answer and the cycle check.
"""

from ..plan import (
    CATEGORY_SCHEMES,
    COMPLETED,
    EDGE_KINDS,
    MARK_KINDS,
    MAX_ACTIVE_CATEGORIES,
    MAX_EDGES,
    MAX_EDGES_PER_TASK,
    NOTE_KINDS,
    PROVIDERS,
    SETTING_KEYS,
    WAITS_FOR,
)
from . import Query, sql_list

TASKS_INDEX = "sqlite_autoindex_plan_tasks_1"  # UNIQUE (provider, external_id)
EDGES_INDEX = "sqlite_autoindex_plan_edges_1"  # PRIMARY KEY (task_id, prerequisite_id, kind)

# The column names are VerifyPlanStoreResponse's fields.
VERIFY_COUNTS = (
    "settings_row_count",
    "task_row_count",
    "mark_row_count",
    "edge_row_count",
    "note_row_count",
    "category_row_count",
    "orphan_mark_count",
    "orphan_edge_count",
    "unknown_value_count",
    "limit_violation_count",
)
VERIFY = (
    "SELECT (SELECT count(*) FROM plan_settings) AS settings_row_count,"
    " (SELECT count(*) FROM plan_tasks) AS task_row_count,"
    " (SELECT count(*) FROM plan_marks) AS mark_row_count,"
    " (SELECT count(*) FROM plan_edges) AS edge_row_count,"
    " (SELECT count(*) FROM plan_notes) AS note_row_count,"
    " (SELECT count(*) FROM plan_categories) AS category_row_count,"
    # A mark or an edge whose task identity is missing: a partial restore, or a bug that wrote one.
    " (SELECT count(*) FROM plan_marks WHERE task_id NOT IN (SELECT id FROM plan_tasks)) AS orphan_mark_count,"
    " (SELECT count(*) FROM plan_edges WHERE task_id NOT IN (SELECT id FROM plan_tasks)"
    " OR prerequisite_id NOT IN (SELECT id FROM plan_tasks)) AS orphan_edge_count,"
    # The CHECKs leave these vocabularies open (core/plan.py closes them).
    f" (SELECT count(*) FROM plan_settings WHERE key NOT IN ({sql_list(SETTING_KEYS)})"
    " OR json_type(value) <> 'object')"
    f" + (SELECT count(*) FROM plan_tasks WHERE provider NOT IN ({sql_list(PROVIDERS)}))"
    f" + (SELECT count(*) FROM plan_marks WHERE kind NOT IN ({sql_list(MARK_KINDS)}))"
    f" + (SELECT count(*) FROM plan_edges WHERE kind NOT IN ({sql_list(EDGE_KINDS)}))"
    f" + (SELECT count(*) FROM plan_notes WHERE kind NOT IN ({sql_list(NOTE_KINDS)}))"
    f" + (SELECT count(*) FROM plan_categories WHERE scheme NOT IN ({sql_list(CATEGORY_SCHEMES)}))"
    " AS unknown_value_count,"
    # Each task over its dependency limit, the dependency total over its limit, each scheme over its limit.
    " (SELECT count(*) FROM (SELECT task_id FROM plan_edges GROUP BY task_id"
    f" HAVING count(*) > {MAX_EDGES_PER_TASK}))"
    f" + ((SELECT count(*) FROM plan_edges) > {MAX_EDGES})"
    " + (SELECT count(*) FROM (SELECT scheme FROM plan_categories WHERE archived_at IS NULL GROUP BY scheme"
    f" HAVING count(*) > {MAX_ACTIVE_CATEGORIES})) AS limit_violation_count"
)

# A dependency as PlusService answers it: the two tasks' external IDs, the baseline, and whether the prerequisite
# was confirmed completed.
_EDGE_COLUMNS = (
    "w.external_id AS task_id, p.external_id AS prerequisite_id, e.baseline_count,"
    f" p.closed_as IS '{COMPLETED}' AS done"
)
# Every dependency, oldest first: a scan of plan_edges (at most MAX_EDGES rows) and two rowid lookups per row.
EDGES = (
    f"SELECT {_EDGE_COLUMNS} FROM plan_edges e JOIN plan_tasks w ON w.id = e.task_id"
    f" JOIN plan_tasks p ON p.id = e.prerequisite_id WHERE e.kind = '{WAITS_FOR}' ORDER BY e.rowid LIMIT {MAX_EDGES}"
)
# What one task waits for, oldest first (at most MAX_EDGES_PER_TASK rows to sort): bind its provider and ID.
TASK_EDGES = Query(
    f"SELECT {_EDGE_COLUMNS} FROM plan_tasks w JOIN plan_edges e ON e.task_id = w.id"
    " JOIN plan_tasks p ON p.id = e.prerequisite_id"
    f" WHERE w.provider = ? AND w.external_id = ? AND e.kind = '{WAITS_FOR}' ORDER BY e.created_at, e.rowid",
    TASKS_INDEX,
    sort_allowed=True,
)
# Gives tasks their Todofy IDs: bind the provider, the time, then a JSON array of external IDs. Only a task the
# store has just confirmed active is registered, so one closed before (a reopened task) is open again; settling
# registers again a task recorded closed that the store lists, for the same reason.
ADD_TASKS = Query(
    "INSERT INTO plan_tasks (provider, external_id, created_at) SELECT ?, value, ? FROM json_each(?) WHERE true"
    " ON CONFLICT (provider, external_id) DO UPDATE SET closed_at = NULL, closed_as = NULL"
    " WHERE closed_as IS NOT NULL",
    TASKS_INDEX,
)
# Bind the baseline, the time, then the provider and ID of the task that waits and of its prerequisite. An edge
# that exists is a done one (the runtime answers one that still holds without a write): it starts over from this
# baseline, in its own row.
ADD_EDGE = Query(
    "INSERT INTO plan_edges (task_id, prerequisite_id, kind, baseline_count, created_at)"
    f" SELECT w.id, p.id, '{WAITS_FOR}', ?, ? FROM plan_tasks w, plan_tasks p"
    " WHERE w.provider = ? AND w.external_id = ? AND p.provider = ? AND p.external_id = ?"
    " ON CONFLICT (task_id, prerequisite_id, kind) DO UPDATE SET baseline_count = excluded.baseline_count",
    TASKS_INDEX,
)
# Bind the provider and ID of the task that waits, then of its prerequisite.
REMOVE_EDGE = Query(
    "DELETE FROM plan_edges WHERE task_id = (SELECT id FROM plan_tasks WHERE provider = ? AND external_id = ?)"
    " AND prerequisite_id = (SELECT id FROM plan_tasks WHERE provider = ? AND external_id = ?)"
    f" AND kind = '{WAITS_FOR}'",
    EDGES_INDEX,
)
# Of the tasks named (bind the provider, then a JSON array of external IDs), those with a Todofy ID: whether each
# waits for a task, is waited for, and what is recorded about its closing.
DEPENDENCY_ROLES = Query(
    "SELECT t.external_id, t.closed_as, EXISTS (SELECT 1 FROM plan_edges e WHERE e.task_id = t.id) AS waits,"
    " EXISTS (SELECT 1 FROM plan_edges e WHERE e.prerequisite_id = t.id) AS awaited"
    " FROM plan_tasks t WHERE t.provider = ? AND t.external_id IN (SELECT value FROM json_each(?))",
    TASKS_INDEX,
)
# Records how the task store says tasks closed (bind the time, 'completed' or 'deleted', the provider, then a JSON
# array of external IDs); a task already recorded keeps its first answer.
CLOSE_TASKS = Query(
    "UPDATE plan_tasks SET closed_at = ?, closed_as = ? WHERE provider = ?"
    " AND external_id IN (SELECT value FROM json_each(?)) AND closed_as IS NULL",
    TASKS_INDEX,
)
# The tasks that wait for any of the tasks named (bind the provider, then a JSON array of external IDs).
WAITERS = Query(
    "SELECT w.external_id FROM plan_tasks p JOIN plan_edges e ON e.prerequisite_id = p.id"
    " JOIN plan_tasks w ON w.id = e.task_id WHERE p.provider = ? AND p.external_id IN (SELECT value FROM json_each(?))",
    TASKS_INDEX,
)
# Removes the dependencies of the tasks named (bind the provider, then a JSON array of external IDs): what they
# wait for (FORGET_WAITS), or what waits for them (FORGET_PREREQUISITES).
FORGET_WAITS = Query(
    "DELETE FROM plan_edges WHERE task_id IN"
    " (SELECT id FROM plan_tasks WHERE provider = ? AND external_id IN (SELECT value FROM json_each(?)))",
    EDGES_INDEX,
)
FORGET_PREREQUISITES = Query(
    "DELETE FROM plan_edges WHERE prerequisite_id IN"
    " (SELECT id FROM plan_tasks WHERE provider = ? AND external_id IN (SELECT value FROM json_each(?)))",
    "plan_edges_prerequisite",
)
