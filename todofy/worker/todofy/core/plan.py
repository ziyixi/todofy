"""The planning store's vocabulary and limits (migrations/0007_plan_store.sql), independent of any task provider.

The tables check only the shape of a setting key, provider, kind or scheme, because SQLite changes a CHECK only by
rebuilding the table; the closed lists live here. Nothing here names a Todoist label or filter: that is the
Todoist adapter's (core/plus.py).
"""

import unicodedata
from datetime import date, timedelta

# plan_settings keys, one JSON object each. 'todoist.mail' is the Todoist adapter's binding of the Mailbox: each mail
# category's label and the project filed mail goes to (runtime/plan_store.py mail_settings).
SETTING_KEYS = ("account", "week", "todoist", "todoist.mail")
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


def prerequisites(edges: list[tuple[str, str]], task_id: str) -> list[str]:
    """Every task ``task_id`` waits for, directly or through other tasks, each once, the nearest first. ``edges``
    are (task, prerequisite) pairs, at most MAX_EDGES; a cycle already in them (a restore, say) still ends."""
    by_task: dict[str, list[str]] = {}
    for task, prerequisite in edges:
        by_task.setdefault(task, []).append(prerequisite)
    seen, found, pending = {task_id}, [], [task_id]
    while pending:
        for prerequisite in by_task.get(pending.pop(0), []):
            if prerequisite not in seen:
                seen.add(prerequisite)
                found.append(prerequisite)
                pending.append(prerequisite)
    return found


def waits_for(edges: list[tuple[str, str]], task_id: str, prerequisite_id: str) -> bool:
    """Whether ``task_id`` already waits for ``prerequisite_id``, directly or through other tasks."""
    return prerequisite_id in prerequisites(edges, task_id)


def check_dependency(
    edges: list[tuple[str, str]], holding: list[tuple[str, str]], task_id: str, prerequisite_id: str
) -> tuple[str | None, tuple[str, str] | None]:
    """Whether ``task_id`` may start waiting for ``prerequisite_id``: why not ("cycle": the task itself, or the
    prerequisite already waits for the task, directly or not; "limit") and None, or None and the dependency that
    gives way to it, if any. ``edges`` are every dependency, oldest first, and ``holding`` those that still hold
    back their task. A done dependency neither closes a cycle nor counts toward MAX_EDGES_PER_TASK, and when the
    store is at a limit (MAX_EDGES_PER_TASK rows for the task, MAX_EDGES in all) the task's oldest done one gives
    way. One that is already there needs no room: a done one starts over in its own row."""
    if task_id == prerequisite_id or waits_for(holding, prerequisite_id, task_id):
        return "cycle", None
    own = [edge for edge in edges if edge[0] == task_id]
    if (task_id, prerequisite_id) in own or (len(own) < MAX_EDGES_PER_TASK and len(edges) < MAX_EDGES):
        return None, None
    done = [edge for edge in own if edge not in holding]
    return (None, done[0]) if done else ("limit", None)


# plan_notes kind 'bets': one line of the owner's text per account week (period: its Monday) and area.
BET_AREAS = ("work", "personal")
# In UTF-16 code units, as the extension's input counts them (an emoji outside the BMP takes two).
MAX_BET_LENGTH = 160


def bet_text(text: str) -> str:
    """A Bet as it is stored: one line, each run of whitespace or control characters one space, trimmed.

    Empty means no Bet. Raises ValueError("BAD_REQUEST") above MAX_BET_LENGTH UTF-16 code units, and
    (UnicodeEncodeError) for a lone surrogate, which no text the extension sends contains.
    """
    line = " ".join("".join(" " if unicodedata.category(c) == "Cc" else c for c in text).split())
    if len(line.encode("utf-16-le")) // 2 > MAX_BET_LENGTH:
        raise ValueError("BAD_REQUEST")
    return line


def bet_weeks(week: str) -> tuple[str, str, str]:
    """The weeks a plan shows Bets for, around the account week starting on Monday ``week``: the previous one
    (Monday's "last week"), this one and the next one (written in Sunday's weekly review)."""
    monday = date.fromisoformat(week)
    week_before, week_after = monday - timedelta(days=7), monday + timedelta(days=7)
    return week_before.isoformat(), monday.isoformat(), week_after.isoformat()


def bet_writable(week: str, current: str) -> bool:
    """Whether a Bet of the week starting on ``week`` may still be written while ``current`` is the account week:
    this week and the next one only, so an ended week's Bet stays as it was."""
    _, this, following = bet_weeks(current)
    return week in (this, following)
