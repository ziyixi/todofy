"""Personal planning rules; Todoist owns task data and the existing label identities."""

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta
from typing import Any

ROLES = (
    "office",
    "home",
    "bets",
    "committed",
    "focus",
    "candiate",
    "lead_1d",
    "lead_3d",
    "lead_1w",
    "lead_2w",
    "lead_1m",
)
LEADS = {"lead_1d": 1, "lead_3d": 3, "lead_1w": 7, "lead_2w": 14, "lead_1m": 30}
PLANNING_ROLES = ("quarter", "candiate", "focus", "committed")
STAGES = {"none": None, "quarterly": "quarter", "monthly": "candiate", "weekly": "focus", "committed": "committed"}
AREAS = {"unassigned": None, "work": "office", "personal": "home"}
ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
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
}


def replaced_filters(filters: list[dict[str, Any]], mapping: list[dict[str, Any]] | None = None) -> list[str]:
    """Match the existing view semantics; names and private filter IDs are never baked in."""
    names = role_labels(mapping)
    result = []
    for row in filters:
        query = row.get("query", "").replace(" ", "").replace("%", "@")
        if query in REPLACED_FILTER_QUERIES and all(names.get(role) == role for role in ROLES if "@" + role in query):
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
        {role: role for role in (*ROLES, "quarter")}
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
    return [retained[role] for role in (*ROLES, "quarter") if role in retained]


def task_etag(task: dict[str, Any], mapping: list[dict[str, Any]] | None = None) -> str:
    values = {key: task.get(key) for key in ("id", "labels", "deadline", "parent_id", "content", "duration")}
    if mapping is not None:
        values["mapping"] = mapping
    return fingerprint(values)


def task_view(task: dict[str, Any], today: str, mapping: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    names = role_labels(mapping)
    labels = set(task.get("labels") or [])
    due = str((task.get("due") or {}).get("date") or "")
    deadline = str((task.get("deadline") or {}).get("date") or "")
    candidate_date = due[:10] if due else deadline
    stage = "none"
    if names.get("committed") in labels:
        stage = "committed"
    elif names.get("quarter") in labels:
        stage = "quarterly"
    elif names.get("focus") in labels and "quick" not in labels:
        stage = "weekly"
    elif names.get("candiate") in labels and "quick" not in labels:
        stage = "monthly"
    elif (
        candidate_date
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
    }
    duration = task.get("duration")
    if duration and duration.get("amount"):
        result["estimated_minutes"] = int(duration["amount"]) * (480 if duration.get("unit") == "day" else 1)
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
    if "bet" in request:
        labels.discard(names["bets"])
        if request["bet"]:
            labels.add(names["bets"])
    return sorted(labels)


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
    if record["bet"]:
        labels.discard(names["bets"])
    return sorted(labels)
