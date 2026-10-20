"""D1 statements of the Mail categories in the planning store (runtime/plan_store.py, migrations/0007_plan_store.sql).

The Mail categories are plan_categories rows of scheme 'mail' (their Tasks label IDs are in plan_settings
'todoist.mail', a frozen key name), replaced as one set in one batch. Planning itself is Tasks'; migration 0013
dropped the store's other tables and settings.
"""

from . import Query

# Active categories of one scheme at most: a bound on the sort, above the Mail rule (core/mailbox.MAX_MAIL_CATEGORIES).
MAX_ACTIVE_CATEGORIES = 20

PLAN_SETTINGS_KEY = "sqlite_autoindex_plan_settings_1"  # PRIMARY KEY (key)
SETTING = Query("SELECT value FROM plan_settings WHERE key = ?", PLAN_SETTINGS_KEY)
SAVE_SETTING = Query(
    "INSERT INTO plan_settings (key, value, updated_at) VALUES (?, ?, ?)"
    " ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    PLAN_SETTINGS_KEY,
)
# The active mail categories in their order (at most core/mailbox.MAX_MAIL_CATEGORIES, so the sort sees a few rows).
MAIL_CATEGORIES = Query(
    "SELECT id, priority FROM plan_categories WHERE scheme = 'mail' AND archived_at IS NULL"
    f" ORDER BY sort_order, id LIMIT {MAX_ACTIVE_CATEGORIES}",
    "plan_categories_name",
    sort_allowed=True,
)
# The next ID a new category takes, under plus_lock (the only writer). Rows are archived, never deleted, so the
# largest ID is AUTOINCREMENT's high-water mark and an ID is never handed out twice.
NEXT_CATEGORY_ID = Query("SELECT coalesce(max(id), 0) + 1 AS id FROM plan_categories", "rowid")
ADD_CATEGORY = Query(
    "INSERT INTO plan_categories (id, scheme, name, priority, sort_order, created_at, updated_at)"
    " VALUES (?, 'mail', ?, ?, ?, ?, ?)",
    "plan_categories_name",
)
# A kept category takes its label's current name and its new place.
KEEP_CATEGORY = Query(
    "UPDATE plan_categories SET name = ?, sort_order = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
    "rowid",
)
ARCHIVE_CATEGORY = Query(
    "UPDATE plan_categories SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", "rowid"
)
