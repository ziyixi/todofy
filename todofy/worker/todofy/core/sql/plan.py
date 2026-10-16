"""D1 reads of the planning store (runtime/plan_store.py, migrations/0007_plan_store.sql).

``VERIFY`` is the owner's check after a restore or a migration (PlusService.VerifyPlanStore): one statement that
counts every row of the six plan tables, so it is a deliberate whole-table read rather than a ``Query``
constant (a count names no index). Every one of these tables is small by design (core/plan.py limits, a few
thousand task identities a year), and only the owner calls it. tests/unit/test_plan_store.py checks that its plan
reads no other table and that each count finds what it should.
"""

from ..plan import (
    CATEGORY_SCHEMES,
    EDGE_KINDS,
    MARK_KINDS,
    MAX_ACTIVE_CATEGORIES,
    MAX_EDGES,
    MAX_EDGES_PER_TASK,
    NOTE_KINDS,
    PROVIDERS,
    SETTING_KEYS,
)
from . import sql_list

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
