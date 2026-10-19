"""Personal planning rules over Tasks' tasks (core/native_task_view.py) and their local role projection
(core/native_plan.py)."""

import hashlib
import json
import re
import uuid
from collections.abc import Collection
from datetime import datetime, timedelta
from typing import Any

from .gtd import parse_instant, rfc3339

ROLES = (
    "office",
    "home",
    "committed",
    "focus",
    "candiate",
    "lead_1d",
    "lead_3d",
    "lead_1w",
    "lead_2w",
    "lead_1m",
)
# The retired Bets role: the weekly Bets are text now (core/plan.py), and no task gets this role again.
LEGACY_ROLES = ("bets",)
NATIVE_FLAGS = ("quick", "waiting", "blocked", "parked", "active", "onhold", "routine", "task")
NATIVE_ROLES = frozenset((*ROLES, *LEGACY_ROLES, "quarter", *NATIVE_FLAGS))
LEADS = {"lead_1d": 1, "lead_3d": 3, "lead_1w": 7, "lead_2w": 14, "lead_1m": 30}
STAGES = {"none": None, "quarterly": "quarter", "monthly": "candiate", "weekly": "focus", "committed": "committed"}
AREAS = {"unassigned": None, "work": "office", "personal": "home"}
ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
# The Todoist filters Plan replaced, read only by the one-time cutover (tools/prepare_native_plan.py).
REPLACED_FILTER_QUERIES = {
    "@bets",
    "@committed",
    "(@candiate&!@quick)",
    "(@focus&!@quick)|((overdue|7days)&!@onhold&!@candiate&!@routine&!@task&!@quick&!@committed)",
    "!nodeadline&!@lead_1d&!@lead_3d&!@lead_1w&!@lead_2w&!@lead_1m&!@parked&!@active",
    "deadlinebefore:today&!@active&!@blocked&!@parked,"
    + ",".join(
        f"(@{label}&deadlineafter:yesterday&deadlinebefore:in{days}"
        f"{'day' if days == 1 else 'days'}&!@active&!@waiting&!@blocked&!@parked)"
        for label, days in LEADS.items()
    ),
    # Waiting with a deadline (two spellings), all waiting and in progress with a deadline: Plan's
    # Review board shows them in Waiting, or in their own stage lane, and an in-progress task needs no lane.
    "!nodeadline&(@blocked)&!@parked",
    "!nodeadline&@blocked&!@parked",
    "@blocked",
    "@active&!nodeadline&!@blocked&!@parked",
    # Quick tasks are Week's Quick source, parked tasks Review's Parked lane (Plan's quickTasks and
    # boardLanes); @parked only while the account has a label of that name (replaced_filters).
    "@quick&(nodate|3days)",
    "@parked",
}
# The set-aside role, which Review's Parked lane shows.
PARKED = "parked"
# Review lanes that show and sort by update time ("N days untouched"): their order stays in Todofy only,
# since an order write may count as an edit of each task it moves.
UNTOUCHED_LANES = ("waiting", "parked")


def replaced_query(query: Any) -> str | None:
    """A filter's query in the normalised form REPLACED_FILTER_QUERIES lists, or None for any other query."""
    if not isinstance(query, str):
        return None
    normalised = query.replace(" ", "").replace("%", "@")
    return normalised if normalised in REPLACED_FILTER_QUERIES else None


def replaced_filters(
    filters: list[dict[str, Any]], mapping: list[dict[str, Any]] | None = None, label_names: Collection[str] = ()
) -> list[str]:
    """Match the existing view semantics; names and private filter IDs are never baked in. ``label_names``: the
    account's labels; @parked is replaced only while one is named parked, as Plan's Parked lane exists."""
    names = role_labels(mapping)
    result = []
    for row in filters:
        query = replaced_query(row.get("query", ""))
        if query == "@" + PARKED and PARKED not in label_names:
            continue
        if query is not None and all(names.get(role) == role for role in ROLES if "@" + role in query):
            result.append(str(row["id"]))
    return result


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def check_id(value: str) -> str:
    if not ID.fullmatch(value) or value.startswith("tmp-"):
        raise ValueError("BAD_REQUEST")
    return value


def action_id(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        raise ValueError("BAD_REQUEST") from error
    if parsed.version != 4 or str(parsed) != value:
        raise ValueError("BAD_REQUEST")
    return value


def command_id(request_id: str, index: int = 0) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"todofy-plus:{request_id}:{index}"))


def week_start(today: str) -> str:
    day = datetime.strptime(today, "%Y-%m-%d").date()
    return (day - timedelta(days=day.weekday())).isoformat()


def membership_week(today: str, week: str, request: dict[str, Any]) -> str:
    """The week whose Monday reset a planning write's marks wait for.

    On the week's last day an explicit commitment is a choice for the next week, so the coming reset
    leaves the task's marks in place: all of them, as a task has one membership row. Every other write
    gives this week, which never moves a kept row back (REMEMBER_WEEK).
    """
    monday = datetime.strptime(week, "%Y-%m-%d").date()
    if request.get("stage") == "committed" and today == (monday + timedelta(days=6)).isoformat():
        return (monday + timedelta(days=7)).isoformat()
    return week


def role_labels(mapping: list[dict[str, Any]] | None = None) -> dict[str, str]:
    return (
        {role: role for role in (*ROLES, *LEGACY_ROLES, "quarter")}
        if mapping is None
        else {row["role"]: row["label"] for row in mapping}
    )


def task_etag(task: dict[str, Any], mapping: list[dict[str, Any]] | None = None) -> str:
    values = {key: task.get(key) for key in ("id", "labels", "deadline", "parent_id", "content", "duration")}
    if task.get("_native_planning"):
        values["native_plan_rev"] = task["_native_plan_rev"]
        values["native_content_etag"] = task.get("_native_etag")
    if mapping is not None:
        values["mapping"] = mapping
    return fingerprint(values)


def child_order(task: dict[str, Any]) -> int | None:
    """The task's whole-number position among its siblings, or None when it does not give an int32 one."""
    order = task.get("child_order")
    return order if isinstance(order, int) and not isinstance(order, bool) and -(2**31) <= order < 2**31 else None


def recurring(task: dict[str, Any]) -> bool:
    return bool((task.get("due") or {}).get("is_recurring"))


def completed_count(task: dict[str, Any]) -> int | None:
    """The task's completion counter (completed_count), which counts every completed recurrence and goes down when
    one is undone; None when the task does not carry it."""
    count = task.get("completed_count")
    return count if isinstance(count, int) and not isinstance(count, bool) and 0 <= count < 2**31 else None


def holds(baseline: int, prerequisite: dict[str, Any]) -> bool:
    """Whether a dependency on an open task still holds back the task that waits (planning-ui's
    dependencies.ts holds): a recurring prerequisite never leaves the open list, so its next completion, a
    completed_count above the baseline, ends it."""
    count = completed_count(prerequisite)
    return not recurring(prerequisite) or count is None or count <= baseline


def label_stage(labels: set[str], names: dict[str, str]) -> str:
    """The stage a task's planning labels give, the highest first; a Quick task is never weekly or monthly."""
    if names.get("committed") in labels:
        return "committed"
    if names.get("quarter") in labels:
        return "quarterly"
    if names.get("focus") in labels and "quick" not in labels:
        return "weekly"
    if names.get("candiate") in labels and "quick" not in labels:
        return "monthly"
    return "none"


def task_view(task: dict[str, Any], today: str, mapping: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    names = role_labels(mapping)
    labels = set(task.get("labels") or [])
    due = str((task.get("due") or {}).get("date") or "")
    deadline = str((task.get("deadline") or {}).get("date") or "")
    candidate_date = due[:10] if due else deadline
    stage = label_stage(labels, names)
    if (
        stage == "none"
        and candidate_date
        and not labels.intersection(
            {
                "onhold",
                "routine",
                "task",
                "quick",
                names.get("candiate"),
                names.get("committed"),
                names.get("quarter"),
                names.get("bets"),
            }
        )
        and candidate_date < (datetime.strptime(today, "%Y-%m-%d").date() + timedelta(days=7)).isoformat()
    ):
        # Preserve the existing date-driven Candidate If view, including overdue tasks.
        stage = "weekly"
    area = "unassigned"
    if (names.get("office") in labels) != (names.get("home") in labels):
        area = "work" if names.get("office") in labels else "personal"
    leads = [days for role, days in LEADS.items() if names.get(role) in labels]
    lead_days = max(leads, default=0)
    start = False
    if deadline and not labels.intersection({"active", "blocked", "parked"}):
        delta = (datetime.strptime(deadline, "%Y-%m-%d").date() - datetime.strptime(today, "%Y-%m-%d").date()).days
        start = delta < 0 or ("waiting" not in labels and any(0 <= delta < lead for lead in leads))
    result = {
        "id": str(task["id"]),
        "title": task.get("content", ""),
        "parent_id": str(task.get("parent_id") or ""),
        "project_id": str(task.get("project_id") or ""),
        "labels": sorted(labels),
        "stage": stage,
        "area": area,
        "bet": names.get("bets") in labels,
        "deadline": deadline,
        "due": due,
        "lead_days": lead_days,
        "etag": task_etag(task, mapping),
        "must_start": start,
        "missing_lead": bool(deadline and not leads and not labels.intersection({"parked", "active"})),
        "priority": int(task.get("priority", 1)),
        "recurring": recurring(task),
    }
    if task.get("_native_planning"):
        result["labels"] = sorted(task.get("_native_content_labels", labels - NATIVE_ROLES))
        result["explicit_stage"] = label_stage(labels, names)
        result["planning_flags"] = [name for name in NATIVE_FLAGS if name in labels and name != "blocked"]
        result["kind"] = task.get("kind", "task")
        result["effort"] = task.get("effort", "")
        state = task["_native_plan_state"]
        lead_days = int(state.get("lead_days", 0))
        result["lead_days"] = lead_days
        excluded = any(state.get(flag) for flag in ("active", "parked"))
        if deadline and not excluded:
            delta = (datetime.strptime(deadline, "%Y-%m-%d").date() - datetime.strptime(today, "%Y-%m-%d").date()).days
            result["must_start"] = delta < 0 or (not state.get("waiting") and lead_days > 0 and delta <= lead_days)
        else:
            result["must_start"] = False
        result["missing_lead"] = bool(deadline and not lead_days and not excluded)
    count = completed_count(task)
    if count is not None:
        result["completed_count"] = count
    if task.get("_native_etag") and isinstance(order := task.get("sort_order"), (int, float)):
        result["sort_order"] = order
    if (order := child_order(task)) is not None:
        result["child_order"] = order
    duration = task.get("duration")
    if duration and duration.get("amount"):
        result["estimated_minutes"] = int(duration["amount"])
    updated = parse_instant(task.get("updated_at"))
    if updated is not None:
        result["update_time"] = rfc3339(updated)
    return result
