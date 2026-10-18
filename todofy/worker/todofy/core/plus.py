"""Personal planning rules; Todoist owns task data and the existing label identities."""

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
# Roles a setup confirmed before their retirement may still bind. The binding is kept exactly as saved and never
# checked against Todoist, so renaming or deleting the label changes no etag and never disables Plus; a new setup
# binds none. The weekly Bets are text now (core/plan.py); a task still labelled Bets loses it at Monday's reset.
LEGACY_ROLES = ("bets",)
NATIVE_FLAGS = ("quick", "waiting", "blocked", "parked", "active", "onhold", "routine", "task")
NATIVE_ROLES = frozenset((*ROLES, *LEGACY_ROLES, "quarter", *NATIVE_FLAGS))
LEADS = {"lead_1d": 1, "lead_3d": 3, "lead_1w": 7, "lead_2w": 14, "lead_1m": 30}
PLANNING_ROLES = ("quarter", "candiate", "focus", "committed")
STAGES = {"none": None, "quarterly": "quarter", "monthly": "candiate", "weekly": "focus", "committed": "committed"}
AREAS = {"unassigned": None, "work": "office", "personal": "home"}
ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
# Todoist's fractional order key among siblings (PlanningTask.order_key).
ORDER_KEY = re.compile(r"^[0-9A-Za-z]{1,100}$")
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
    # Waiting with a deadline (two spellings), all waiting and in progress with a deadline: the extension's
    # Review board shows them in Waiting, or in their own stage lane, and an in-progress task needs no lane.
    "!nodeadline&(@blocked)&!@parked",
    "!nodeadline&@blocked&!@parked",
    "@blocked",
    "@active&!nodeadline&!@blocked&!@parked",
    # Quick tasks are Week's Quick source, parked tasks Review's Parked lane (the extension's quickTasks and
    # boardLanes); @parked only while the account has a label of that name (replaced_filters).
    "@quick&(nodate|3days)",
    "@parked",
}
# The owner's literal in-progress label, as the in-progress deadline query names it. Plus never creates it.
ACTIVE = "active"
# The owner's literal set-aside label, which Review's Parked lane shows. Plus never creates it either.
PARKED = "parked"
# Review lanes that show and sort by Todoist's update time ("N days untouched"): their order stays in Todofy only,
# since a Todoist order write may count as an edit of each task it moves.
UNTOUCHED_LANES = ("waiting", "parked")
# plan_tasks.provider of a Todoist task ID (core/plan.py PROVIDERS).
PROVIDER = "todoist"
# The literal labels that clarify a mail task in place (waiting, someday or quick), as the extension's
# weekly-review.ts lists them: such a task has left the Mailbox, as one with a planning stage has.
CLARIFIED_LABELS = frozenset({"waiting", "blocked", "parked", "onhold", "quick"})
# Roles whose labels a mail category never uses: Plus writes them by other means (stages, the retired Bets, leads).
NOT_MAIL_ROLES = frozenset({*PLANNING_ROLES, *LEGACY_ROLES, *LEADS})


MAX_METADATA_ITEMS = 500


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
    account's labels; @parked is replaced only while one is named parked, as the extension's Parked lane exists."""
    names = role_labels(mapping)
    result = []
    for row in filters:
        query = replaced_query(row.get("query", ""))
        if query == "@" + PARKED and PARKED not in label_names:
            continue
        if query is not None and all(names.get(role) == role for role in ROLES if "@" + role in query):
            result.append(str(row["id"]))
    return result


def merge_metadata(previous: dict[str, Any] | None, answer: dict[str, Any]) -> dict[str, Any]:
    """The metadata cache after one Sync answer for user, labels and filters (runtime/plus_todoist.py).

    ``previous`` is None for a full answer, which replaces the cache; an incremental answer lists only what
    changed since its token, merged by ID: an item with ``is_deleted`` leaves. The user object is reduced to its
    timezone, and only filters whose query REPLACED_FILTER_QUERIES lists are kept, normalised, so no private
    filter text is stored; a kept filter whose query changes to any other leaves. ``queries`` names that list
    (REPLACED_QUERIES_VERSION): a cache kept under another list starts over in full. Raises ValueError on an answer
    that does not have this shape.
    """
    token = answer.get("sync_token")
    if not isinstance(token, str) or not 1 <= len(token) <= 1024:
        raise ValueError("sync_token")
    # A full answer lists every label and filter; an incremental one leaves out a resource with no change.
    unchanged = [] if previous is not None else None
    labels, filters = answer.get("labels", unchanged), answer.get("filters", unchanged)
    if not isinstance(labels, list) or not isinstance(filters, list):
        raise ValueError("resources")
    named = dict(previous["labels"]) if previous else {}
    for label in labels:
        key, name = str(label.get("id") or ""), label.get("name")
        if label.get("is_deleted") or not isinstance(name, str) or not name:
            named.pop(key, None)
        elif key:
            named[key] = name
    queries = dict(previous["filters"]) if previous else {}
    for row in filters:
        key, query = str(row.get("id") or ""), replaced_query(row.get("query"))
        if row.get("is_deleted") or query is None:
            queries.pop(key, None)
        elif key:
            queries[key] = query
    # The user object includes credentials and personal information: only its timezone is kept.
    timezone = ((answer.get("user") or {}).get("tz_info") or {}).get("timezone")
    if timezone is None and previous is not None:
        timezone = previous["timezone"]
    if not isinstance(timezone, str) or not timezone or len(named) > MAX_METADATA_ITEMS:
        raise ValueError("user")
    return {
        "sync_token": token,
        "timezone": timezone,
        "labels": list(named.items()),
        "filters": list(queries.items()),
        "queries": REPLACED_QUERIES_VERSION,
    }


def metadata_view(cached: dict[str, Any]) -> dict[str, Any]:
    """The cache as the Plus handlers read Todoist's metadata: the timezone, labels and the kept filters."""
    return {
        "timezone": cached["timezone"],
        "labels": [{"id": key, "name": name} for key, name in cached["labels"]],
        "filters": [{"id": key, "query": query} for key, query in cached["filters"]],
    }


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


# The metadata cache keeps only the filters this list replaces: an incremental Sync lists a filter only when it
# changes, so a cache kept under another list would never learn of an existing filter the list now names.
REPLACED_QUERIES_VERSION = fingerprint(sorted(REPLACED_FILTER_QUERIES))


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


def discover(
    labels: list[dict[str, Any]], timezone: str, mapping: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """Saved IDs stay authoritative. New optional labels never alter a confirmed mapping."""
    mapped = []
    missing = []
    if mapping is None:
        for role in (*ROLES, "quarter"):
            matches = [label for label in labels if label.get("name") == role and label.get("id")]
            if len(matches) == 1:
                mapped.append({"role": role, "id": str(matches[0]["id"]), "label": role})
            elif role != "quarter":
                missing.append(role)
    else:
        for binding in mapping:
            if binding["role"] in LEGACY_ROLES:
                mapped.append(binding)
                continue
            matches = [label for label in labels if str(label.get("id", "")) == binding["id"]]
            if len(matches) == 1 and matches[0].get("name"):
                mapped.append({**binding, "label": matches[0]["name"]})
            else:
                missing.append(binding["role"])
        missing.extend(role for role in ROLES if not any(row["role"] == role for row in mapping))
    available = [
        {"id": str(label["id"]), "label": label["name"]}
        for label in labels
        if label.get("id") and isinstance(label.get("name"), str) and label["name"]
    ]
    return {
        "labels": mapped,
        "missing_labels": missing,
        "etag": fingerprint([mapped, timezone]),
        "available_labels": available,
    }


def role_labels(mapping: list[dict[str, Any]] | None = None) -> dict[str, str]:
    return (
        {role: role for role in (*ROLES, *LEGACY_ROLES, "quarter")}
        if mapping is None
        else {row["role"]: row["label"] for row in mapping}
    )


def replace_planning_labels(
    current: list[dict[str, Any]], bindings: list[dict[str, Any]], available: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Only column bindings change; other role identities cannot be reused."""
    roles = {binding["role"] for binding in bindings}
    if (
        len(bindings) not in (3, 4)
        or len(roles) != len(bindings)
        or roles - set(PLANNING_ROLES)
        or not {"candiate", "focus", "committed"}.issubset(roles)
    ):
        raise ValueError("BAD_REQUEST")
    retained = {binding["role"]: binding for binding in current if binding["role"] not in PLANNING_ROLES}
    for binding in bindings:
        check_id(binding["id"])
        matches = [label for label in available if label["id"] == binding["id"]]
        if len(matches) != 1 or matches[0]["label"] != binding["label"]:
            raise ValueError("BAD_REQUEST")
        retained[binding["role"]] = {"role": binding["role"], "id": binding["id"], "label": binding["label"]}
    values = list(retained.values())
    if len({binding["id"] for binding in values}) != len(values) or len(
        {binding["label"] for binding in values}
    ) != len(values):
        raise ValueError("BAD_REQUEST")
    return [retained[role] for role in (*ROLES, *LEGACY_ROLES, "quarter") if role in retained]


def task_etag(task: dict[str, Any], mapping: list[dict[str, Any]] | None = None) -> str:
    values = {key: task.get(key) for key in ("id", "labels", "deadline", "parent_id", "content", "duration")}
    if task.get("_native_planning"):
        values["native_plan_rev"] = task["_native_plan_rev"]
        values["native_content_etag"] = task.get("_native_etag")
    if mapping is not None:
        values["mapping"] = mapping
    return fingerprint(values)


def child_order(task: dict[str, Any]) -> int | None:
    """Todoist's legacy position among the task's siblings, or None when it does not give an int32 one."""
    order = task.get("child_order")
    return order if isinstance(order, int) and not isinstance(order, bool) and -(2**31) <= order < 2**31 else None


def recurring(task: dict[str, Any]) -> bool:
    return bool((task.get("due") or {}).get("is_recurring"))


def completed_count(task: dict[str, Any]) -> int | None:
    """Todoist's completion counter (completed_count), which counts every completed recurrence and goes down when
    one is undone; None when the task does not carry it."""
    count = task.get("completed_count")
    return count if isinstance(count, int) and not isinstance(count, bool) and 0 <= count < 2**31 else None


def holds(baseline: int, prerequisite: dict[str, Any]) -> bool:
    """Whether a dependency on an active task still holds back the task that waits (the extension's
    dependencies.ts holds): a recurring prerequisite never leaves the active list, so its next completion, a
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
    if isinstance(key := task.get("order_key"), str) and ORDER_KEY.fullmatch(key):
        result["order_key"] = key
    duration = task.get("duration")
    if duration and duration.get("amount"):
        result["estimated_minutes"] = int(duration["amount"]) * (480 if duration.get("unit") == "day" else 1)
    updated = parse_instant(task.get("updated_at"))
    if updated is not None:
        result["update_time"] = rfc3339(updated)
    return result


def plan_labels(
    task: dict[str, Any], request: dict[str, Any], mapping: list[dict[str, Any]] | None = None
) -> list[str]:
    names = role_labels(mapping)
    labels = set(task.get("labels") or [])
    if "stage" in request:
        stage = request["stage"]
        if stage not in STAGES:
            raise ValueError("BAD_REQUEST")
        # Only a change of stage replaces the planning labels. Choosing the stage the task already shows
        # (a Sunday keep, a details save) leaves its other horizon labels, such as quarter, in place.
        if label_stage(labels, names) != stage:
            labels -= {names[role] for role in PLANNING_ROLES if role in names}
            if STAGES[stage]:
                label = names.get(STAGES[stage])
                if label is None:
                    raise ValueError("BAD_REQUEST")
                labels.add(label)
    if "area" in request:
        area = request["area"]
        if area not in AREAS:
            raise ValueError("BAD_REQUEST")
        labels -= {names[role] for role in ("office", "home") if role in names}
        if AREAS[area]:
            labels.add(names[AREAS[area]])
    for field, name in (
        ("quick", "quick"),
        ("waiting", "waiting"),
        ("routine", "routine"),
        ("on_hold", "onhold"),
        ("blocked", "blocked"),
        ("single_action", "task"),
    ):
        if field in request:
            if not task.get("_native_planning"):
                raise ValueError("BAD_REQUEST")
            labels.discard(name)
            if request[field]:
                labels.add(name)
    if "bet" in request:
        # Retired: the weekly Bets are text (SetWeeklyBet), and Plus never writes the Bets label again.
        raise ValueError("BAD_REQUEST")
    if "active" in request:
        labels.discard(ACTIVE)
        if request["active"]:
            labels.add(ACTIVE)
    if "parked" in request:
        # Last, so it wins: a parked task has no planning stage (whatever label_stage says, so a Quick task's focus
        # goes too) and is not in progress.
        labels.discard(PARKED)
        if request["parked"]:
            labels -= {names[role] for role in PLANNING_ROLES if role in names}
            labels.discard(ACTIVE)
            labels.add(PARKED)
    return sorted(labels)


def _siblings(task: dict[str, Any]) -> tuple[str, str, str]:
    """The group Todoist orders a task in: its project, section and parent."""
    return str(task.get("project_id") or ""), str(task.get("section_id") or ""), str(task.get("parent_id") or "")


def reorder_items(tasks: list[dict[str, Any]], moved: str) -> list[dict[str, Any]]:
    """item_reorder's items for ``tasks`` in their new order: the group of Todoist siblings of ``moved`` among them
    (same project, section and parent) gets its own child_order values, smallest first, in the given order; only the
    items whose value changes. [] when that group has one task, or a value that is missing, not an int32, or
    repeated (a permutation of equal values changes nothing). Other groups are never touched."""
    task = next((task for task in tasks if str(task["id"]) == moved), None)
    if task is None:
        return []
    group = [sibling for sibling in tasks if _siblings(sibling) == _siblings(task)]
    orders = [child_order(sibling) for sibling in group]
    if len(group) < 2 or None in orders or len(set(orders)) != len(orders):
        return []
    return [
        {"id": str(sibling["id"]), "child_order": order}
        for sibling, order in zip(group, sorted(orders), strict=True)
        if sibling["child_order"] != order
    ]


def reorder_command(request_id: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """The one Sync command that writes an order. item_reorder is deprecated by Todoist with no removal date; its
    replacement (item_update with order_key) changes here alone."""
    return {"type": "item_reorder", "uuid": command_id(request_id), "args": {"items": items}}


def lead_args(
    task: dict[str, Any], deadline: str, days: int, mapping: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    names = role_labels(mapping)
    if deadline:
        try:
            if datetime.strptime(deadline, "%Y-%m-%d").date().isoformat() != deadline:
                raise ValueError
        except ValueError as error:
            raise ValueError("BAD_REQUEST") from error
    if days not in (0, *LEADS.values()) or (days and not deadline):
        raise ValueError("BAD_REQUEST")
    labels = set(task.get("labels") or []) - {names[role] for role in LEADS if role in names}
    labels.update(names[role] for role, value in LEADS.items() if value == days)
    return {"labels": sorted(labels), "deadline": {"date": deadline} if deadline else None}


def reset_labels(
    task: dict[str, Any], record: dict[str, Any], mapping: list[dict[str, Any]] | None = None
) -> list[str]:
    names = role_labels(mapping)
    labels = set(task.get("labels") or [])
    if record["committed"] and names.get("committed") in labels:
        labels -= {names["committed"], names["candiate"]}
        labels.add(names["focus"])
    if record["bet"] and names.get("bets") in labels:
        labels.discard(names["bets"])
    return sorted(labels)


# ---- Mailbox (core/mailbox.py has the domain rules) -------------------------------------------------------------


def api_priority(priority: int) -> int:
    """Todoist's API priority of a domain priority: P1 (1) is 4, P4 is 1."""
    return 5 - priority


def in_mailbox(view: dict[str, Any], inbox_project_id: str) -> bool:
    """Whether a task_view is still to clarify in the mail project, as the extension's inboxToClarify says: a
    top-level task with no planning stage and none of CLARIFIED_LABELS. Whether it is mail is the ledger's to say."""
    return (
        bool(inbox_project_id)
        and view["project_id"] == inbox_project_id
        and not view["parent_id"]
        and view["stage"] == "none"
        and not CLARIFIED_LABELS.intersection(view["labels"])
    )


def mail_label(label: dict[str, str], mapping: list[dict[str, Any]] | None) -> bool:
    """Whether a current label ({"id", "label"}) may be a mail category's: any but a planning stage's, the retired
    Bets', a lead window's and the in-progress label. The two area labels may."""
    reserved = {row["id"] for row in mapping or [] if row["role"] in NOT_MAIL_ROLES}
    return label["id"] not in reserved and label["label"] != ACTIVE


def filed_labels(task: dict[str, Any], label: str, mapping: list[dict[str, Any]] | None) -> list[str]:
    """The labels a mail task keeps when it is filed by a category of ``label``: every one it has and the category's;
    an area label replaces the other area label, so the two stay exclusive."""
    names = role_labels(mapping)
    labels = set(task.get("labels") or []) | {label}
    areas = {names[role] for role in ("office", "home") if role in names}
    if label in areas:
        labels -= areas - {label}
    return sorted(labels)


def untouched(task: dict[str, Any], parents: set[str]) -> bool:
    """Whether the owner left a mail task as Todofy created it, by Todoist's own fields: no label, priority P4, no
    date, deadline or estimate, no sub-task (``parents`` holds the parent IDs of the project's tasks) and no
    comment. A task whose comment count Todoist does not give is not untouched."""
    return (
        not task.get("labels")
        and not task.get("_native_content_labels")
        and int(task.get("priority") or 1) == 1
        and not task.get("due")
        and not task.get("deadline")
        and not task.get("duration")
        and str(task["id"]) not in parents
        and task.get("note_count") == 0
    )
