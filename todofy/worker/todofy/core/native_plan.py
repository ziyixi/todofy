"""Pure conversion between native planning state and the existing rules' private role strings."""

from collections.abc import Iterable
from datetime import date
from typing import Any

from . import plus

FLAG_NAMES = plus.NATIVE_FLAGS
ROLE_NAMES = plus.NATIVE_ROLES
# Private rule input only. Native Plan does not expose this as label configuration.
CANONICAL_MAPPING = [{"role": role, "id": role, "label": role} for role in (*plus.ROLES, "quarter")]


def state_from_labels(labels: Iterable[str], mapping: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Convert an exact saved mapping at cutover, or canonical internal labels on a native edit."""
    labels = set(labels)
    names = plus.role_labels(mapping)
    work, personal = names.get("office") in labels, names.get("home") in labels
    return {
        "stage": plus.label_stage(labels, names),
        "area": ("work" if work else "personal") if work != personal else "unassigned",
        "lead_days": max((days for role, days in plus.LEADS.items() if names.get(role) in labels), default=0),
        **{flag: flag in labels for flag in FLAG_NAMES},
    }


def labels_from_state(state: dict[str, Any]) -> list[str]:
    labels = [flag for flag in FLAG_NAMES if state.get(flag) or (flag == "task" and state.get("quick"))]
    if role := plus.STAGES[state.get("stage", "none")]:
        labels.append(role)
    if role := plus.AREAS[state.get("area", "unassigned")]:
        labels.append(role)
    labels.extend(role for role, days in plus.LEADS.items() if days == state.get("lead_days", 0))
    return labels


def apply_plan(state: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    if "bet" in request:
        raise ValueError("BAD_REQUEST")
    if request.get("blocked"):
        raise ValueError("BAD_REQUEST")
    updated = {**state, "task": bool(state.get("task") or state.get("quick"))}
    for field, allowed in (("stage", plus.STAGES), ("area", plus.AREAS)):
        if field in request:
            if request[field] not in allowed:
                raise ValueError("BAD_REQUEST")
            updated[field] = request[field]
    for flag in FLAG_NAMES:
        field = {"onhold": "on_hold", "task": "single_action"}.get(flag, flag)
        if field in request:
            if not isinstance(request[field], bool):
                raise ValueError("BAD_REQUEST")
            updated[flag] = request[field]
    if request.get("parked"):
        updated.update(stage="none", active=False)
    if updated.get("quick"):
        updated["task"] = True
    return updated


def apply_lead(state: dict[str, Any], deadline: str, days: int) -> dict[str, Any]:
    if deadline and date.fromisoformat(deadline).isoformat() != deadline:
        raise ValueError("BAD_REQUEST")
    if isinstance(days, bool) or not isinstance(days, int) or not 0 <= days <= 365 or (days and not deadline):
        raise ValueError("BAD_REQUEST")
    return {**state, "lead_days": days}
