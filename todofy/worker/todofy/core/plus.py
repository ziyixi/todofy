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
STAGES = {"none": None, "monthly": "candiate", "weekly": "focus", "committed": "committed"}
AREAS = {"unassigned": None, "work": "office", "personal": "home"}
ID = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")
REPLACED_FILTER_QUERIES = {
    "@bets",
    "@committed",
    "(@candiate&!@quick)",
    "(@focus&!@quick)|((overdue|7days)&!@onhold&!@candiate&!@routine&!@task&!@quick&!@committed)",
    "@quick&(nodate|3days)",
    "!nodeadline&!@lead_1d&!@lead_3d&!@lead_1w&!@lead_2w&!@lead_1m&!@parked&!@active",
    "deadlinebefore:today&!@active&!@blocked&!@parked,"
    + ",".join(
        f"(@{label}&deadlineafter:yesterday&deadlinebefore:in{days}"
        f"{'day' if days == 1 else 'days'}&!@active&!@waiting&!@blocked&!@parked)"
        for label, days in LEADS.items()
    ),
}


def replaced_filters(filters: list[dict[str, Any]]) -> list[str]:
    """Match the existing view semantics; names and private filter IDs are never baked in."""
    return [
        str(row["id"])
        for row in filters
        if row.get("query", "").replace(" ", "").replace("%", "@") in REPLACED_FILTER_QUERIES
    ]


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


def discover(labels: list[dict[str, Any]], timezone: str) -> dict[str, Any]:
    """Exact known names only. Ambiguous/missing IDs require owner action, never fuzzy adoption."""
    mapped = []
    missing = []
    for role in ROLES:
        matches = [label for label in labels if label.get("name") == role and label.get("id")]
        if len(matches) != 1:
            missing.append(role)
        else:
            mapped.append({"role": role, "id": str(matches[0]["id"]), "label": role})
    return {"labels": mapped, "missing_labels": missing, "etag": fingerprint([mapped, timezone])}


def task_etag(task: dict[str, Any]) -> str:
    return fingerprint({key: task.get(key) for key in ("id", "labels", "deadline", "parent_id", "content", "duration")})


def task_view(task: dict[str, Any], today: str) -> dict[str, Any]:
    labels = set(task.get("labels") or [])
    due = str((task.get("due") or {}).get("date") or "")
    deadline = str((task.get("deadline") or {}).get("date") or "")
    candidate_date = due[:10] if due else deadline
    stage = "none"
    if "committed" in labels:
        stage = "committed"
    elif "focus" in labels and "quick" not in labels:
        stage = "weekly"
    elif "candiate" in labels and "quick" not in labels:
        stage = "monthly"
    elif (
        candidate_date
        and not labels.intersection({"onhold", "candiate", "routine", "task", "quick", "committed"})
        and candidate_date < (datetime.strptime(today, "%Y-%m-%d").date() + timedelta(days=7)).isoformat()
    ):
        # Preserve the existing date-driven Candidate If view, including overdue tasks.
        stage = "weekly"
    area = "unassigned"
    if ("office" in labels) != ("home" in labels):
        area = "work" if "office" in labels else "personal"
    leads = [days for label, days in LEADS.items() if label in labels]
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
        "bet": "bets" in labels,
        "deadline": deadline,
        "due": due,
        "lead_days": lead_days,
        "etag": task_etag(task),
        "must_start": start,
        "missing_lead": bool(deadline and not leads and not labels.intersection({"parked", "active"})),
        "priority": int(task.get("priority", 1)),
    }
    duration = task.get("duration")
    if duration and duration.get("amount"):
        result["estimated_minutes"] = int(duration["amount"]) * (480 if duration.get("unit") == "day" else 1)
    return result


def plan_labels(task: dict[str, Any], request: dict[str, Any]) -> list[str]:
    labels = set(task.get("labels") or [])
    if "stage" in request:
        stage = request["stage"]
        if stage not in STAGES:
            raise ValueError("BAD_REQUEST")
        labels -= {"candiate", "focus", "committed"}
        if STAGES[stage]:
            labels.add(STAGES[stage])
    if "area" in request:
        area = request["area"]
        if area not in AREAS:
            raise ValueError("BAD_REQUEST")
        labels -= {"office", "home"}
        if AREAS[area]:
            labels.add(AREAS[area])
    if "bet" in request:
        labels.discard("bets")
        if request["bet"]:
            labels.add("bets")
    return sorted(labels)


def lead_args(task: dict[str, Any], deadline: str, days: int) -> dict[str, Any]:
    if deadline:
        try:
            if datetime.strptime(deadline, "%Y-%m-%d").date().isoformat() != deadline:
                raise ValueError
        except ValueError as error:
            raise ValueError("BAD_REQUEST") from error
    if days not in (0, *LEADS.values()) or (days and not deadline):
        raise ValueError("BAD_REQUEST")
    labels = set(task.get("labels") or []) - set(LEADS)
    labels.update(label for label, value in LEADS.items() if value == days)
    return {"labels": sorted(labels), "deadline": {"date": deadline} if deadline else None}


def reset_labels(task: dict[str, Any], record: dict[str, Any]) -> list[str]:
    labels = set(task.get("labels") or [])
    if record["committed"] and "committed" in labels:
        labels -= {"committed", "candiate"}
        labels.add("focus")
    if record["bet"]:
        labels.discard("bets")
    return sorted(labels)
