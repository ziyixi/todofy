"""TodofyCore's own SQLite for Plus: values rebuilt from Todoist or D1.

Everything here may be lost, as the coordinator's rule says: a lost value is read again from where it came
from. The rollback switch PLUS_METADATA=full turns every cache off, so each call reads Todoist and D1 as
before this table existed.
"""

import json
from typing import Any, NamedTuple

from todofy.runtime.config import var

# One JSON value per key, each with its own age:
#   'todoist'      {"sync_token", "timezone", "labels": [[id, name]], "filters": [[id, query]], "queries"}: the
#                  incremental Sync of user, labels and filters (core/plus.merge_metadata); "queries" names the
#                  replaced filter queries it was kept under (REPLACED_QUERIES_VERSION)
#   'connections'  ["<token_sha256>", ...]: the non-revoked rows of D1 plus_connections
#   'full_syncs'   {"window": <unix s>, "count": n}: full Syncs started in the current 15-minute window
DO_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS plus_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, refreshed_at INTEGER NOT NULL)",
)


class Cached(NamedTuple):
    value: Any
    refreshed_at: int  # Unix seconds


def enabled(env: Any) -> bool:
    """False under the rollback switch PLUS_METADATA=full."""
    return var(env, "PLUS_METADATA", "cache") != "full"


def get(store: Any, key: str) -> Cached | None:
    rows = store.exec("SELECT value, refreshed_at FROM plus_cache WHERE key = ?", key).toArray()
    return Cached(json.loads(rows[0].value), int(rows[0].refreshed_at)) if rows else None


def put(store: Any, key: str, value: Any, now: int) -> None:
    store.exec(
        "INSERT INTO plus_cache (key, value, refreshed_at) VALUES (?, ?, ?)"
        " ON CONFLICT (key) DO UPDATE SET value = excluded.value, refreshed_at = excluded.refreshed_at",
        key,
        json.dumps(value, separators=(",", ":")),
        now,
    )


def drop(store: Any, key: str) -> None:
    store.exec("DELETE FROM plus_cache WHERE key = ?", key)
