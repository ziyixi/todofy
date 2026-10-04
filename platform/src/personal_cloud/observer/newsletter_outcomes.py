"""Validate optional Newsletter v2 observations before the typed host receipt."""

import datetime as dt

from personal_cloud.observer.transport import ObserverError

CATEGORIES = {
    "interrupted_activities",
    "packets",
    "workflow_attempts",
    "notion_entities",
    "notion_versions",
    "delivery",
}


def outcomes(value: dict) -> dict:
    counts, revision = value["unknown_by_kind"], value["unknown_revision"]
    if (
        not isinstance(counts, dict)
        or set(counts) != CATEGORIES
        or any(type(n) is not int or not 0 <= n <= 2147483647 for n in counts.values())
        or sum(counts.values()) != value["unknown_count"]
        or type(revision) is not int
        or not 0 <= revision <= 2147483647
    ):
        raise ObserverError("NEWSLETTER_OUTCOMES_INVALID")
    result = {"unknown_by_kind": counts, "unknown_revision": revision}
    delivery = value["latest_delivery"]
    if delivery is not None:
        if (
            not isinstance(delivery, dict)
            or set(delivery) != {"state", "time"}
            or not isinstance(delivery["state"], str)
            or delivery["state"] not in {"provider_accepted", "rejected", "unknown"}
            or not isinstance(delivery["time"], str)
        ):
            raise ObserverError("NEWSLETTER_OUTCOMES_INVALID")
        try:
            timestamp = dt.datetime.fromisoformat(
                delivery["time"].replace("Z", "+00:00")
            )
            if timestamp.tzinfo is None:
                raise ValueError
            normalized = (
                timestamp.astimezone(dt.UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
        except (ValueError, OverflowError):
            raise ObserverError("NEWSLETTER_OUTCOMES_INVALID") from None
        result.update(
            latest_delivery_state=delivery["state"],
            latest_delivery_time=normalized,
        )
    return result
