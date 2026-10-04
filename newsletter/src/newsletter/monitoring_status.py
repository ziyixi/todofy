"""Content-free outcome observations, separate from business state."""

import hashlib
import json
from typing import TypedDict

import newsletter.store as storage


class DeliveryObservation(TypedDict):
    """Provider outcome and record update time, without message content."""

    state: str
    time: str


class Observations(TypedDict):
    """Bounded monitoring data; no authority to resolve business records."""

    unknown_by_kind: dict[str, int]
    unknown_revision: int
    latest_delivery: DeliveryObservation | None


UNKNOWN_SOURCES = {
    "interrupted_activities": ("deployment_activities", "state='interrupted'"),
    "packets": ("packets", "projection='unknown'"),
    "workflow_attempts": ("workflow_attempts", "state='unknown'"),
    "notion_entities": ("notion_entities", "create_state='unknown'"),
    "notion_versions": ("notion_versions", "state='unknown'"),
    "delivery": ("editions", "json_extract(body,'$.delivery_state')='unknown'"),
}


def snapshot(store: storage.Store) -> Observations:
    """Hash record identities so removal cannot reopen a dismissed batch."""
    with store.transaction():
        store.db.execute(
            "CREATE TABLE IF NOT EXISTS monitoring_unknowns ("
            "sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
            "identity TEXT UNIQUE NOT NULL)"
        )
        counts = {}
        for category, (table, predicate) in UNKNOWN_SOURCES.items():
            columns = store.db.execute(f"PRAGMA table_info({table})").fetchall()
            keys = [row["name"] for row in columns if row["pk"]]
            if not keys:
                counts[category] = 0
                continue
            rows = store.db.execute(
                f"SELECT {','.join(keys)} FROM {table} WHERE {predicate}"
            ).fetchall()
            counts[category] = len(rows)
            for row in rows:
                identity = hashlib.sha256(
                    json.dumps(
                        [category, list(row)], separators=(",", ":")
                    ).encode()
                ).hexdigest()
                # Do not consume AUTOINCREMENT values for repeated observations.
                store.db.execute(
                    "INSERT INTO monitoring_unknowns(identity) SELECT ? "
                    "WHERE NOT EXISTS "
                    "(SELECT 1 FROM monitoring_unknowns WHERE identity=?)",
                    (identity, identity),
                )
        revision = store.db.execute(
            "SELECT COALESCE(MAX(sequence),0) FROM monitoring_unknowns"
        ).fetchone()[0]
        latest = store.db.execute(
            "SELECT json_extract(body,'$.delivery_state') state, "
            "json_extract(body,'$.updated_at') time FROM editions "
            "WHERE json_extract(body,'$.delivery_state') IN "
            "('provider_accepted','rejected','unknown') "
            "AND COALESCE(json_extract(body,'$.is_fixture'),0)=0 "
            "ORDER BY json_extract(body,'$.updated_at') DESC, id DESC LIMIT 1"
        ).fetchone()
        return {
            "unknown_by_kind": counts,
            "unknown_revision": revision,
            "latest_delivery": {
                "state": latest["state"],
                "time": latest["time"],
            }
            if latest
            else None,
        }
