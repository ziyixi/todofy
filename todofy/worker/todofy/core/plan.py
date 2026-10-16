"""The planning store's vocabulary and limits (migrations/0007_plan_store.sql), independent of any task provider.

The tables check only the shape of a setting key, provider, kind or scheme, because SQLite changes a CHECK only by
rebuilding the table; the closed lists live here. Nothing here names a Todoist label or filter: that is the
Todoist adapter's (core/plus.py).
"""

# plan_settings keys, one JSON object each.
SETTING_KEYS = ("account", "week", "todoist")
# plan_tasks.provider: the task store an external_id belongs to.
PROVIDERS = ("todoist",)
# plan_marks.kind: committed and bet are a week's last-day choices, kept a someday task kept in a weekly review.
MARK_KINDS = ("committed", "bet", "kept")
# plan_edges.kind
EDGE_KINDS = ("waits_for",)
# plan_notes.kind: the week's Work and Personal Bets, and the week's review progress.
NOTE_KINDS = ("bets", "review")
# plan_categories.scheme: the Mailbox triage.
CATEGORY_SCHEMES = ("mail",)

MAX_EDGES_PER_TASK = 5
MAX_EDGES = 300
MAX_ACTIVE_CATEGORIES = 20
