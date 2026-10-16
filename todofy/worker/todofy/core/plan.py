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
# plan_edges.kind. waits_for, a dependency: task_id should not start before prerequisite_id is done.
WAITS_FOR = "waits_for"
EDGE_KINDS = (WAITS_FOR,)
# plan_notes.kind: the week's Work and Personal Bets, and the week's review progress.
NOTE_KINDS = ("bets", "review")
# plan_categories.scheme: the Mailbox triage.
CATEGORY_SCHEMES = ("mail",)

MAX_EDGES_PER_TASK = 5
MAX_EDGES = 300
MAX_ACTIVE_CATEGORIES = 20
# plan_tasks.closed_as (a closed IN-list CHECK): what the task store confirmed about a task it no longer lists.
COMPLETED = "completed"
DELETED = "deleted"


def waits_for(edges: list[tuple[str, str]], task_id: str, prerequisite_id: str) -> bool:
    """Whether ``task_id`` already waits for ``prerequisite_id``, directly or through other tasks. ``edges`` are
    (task, prerequisite) pairs, at most MAX_EDGES."""
    prerequisites: dict[str, list[str]] = {}
    for task, prerequisite in edges:
        prerequisites.setdefault(task, []).append(prerequisite)
    seen, pending = {task_id}, [task_id]
    while pending:
        for prerequisite in prerequisites.get(pending.pop(), []):
            if prerequisite == prerequisite_id:
                return True
            if prerequisite not in seen:
                seen.add(prerequisite)
                pending.append(prerequisite)
    return False


def dependency_refusal(edges: list[tuple[str, str]], task_id: str, prerequisite_id: str) -> str | None:
    """Why ``task_id`` may not start waiting for ``prerequisite_id``, or None: the task itself, a cycle (the
    prerequisite already waits for the task, directly or not), or a limit (MAX_EDGES_PER_TASK, MAX_EDGES).
    An edge that ``edges`` already holds is never refused: adding it again changes nothing."""
    if (task_id, prerequisite_id) in edges:
        return None
    if task_id == prerequisite_id or waits_for(edges, prerequisite_id, task_id):
        return "cycle"
    if sum(task == task_id for task, _ in edges) >= MAX_EDGES_PER_TASK or len(edges) >= MAX_EDGES:
        return "limit"
    return None
