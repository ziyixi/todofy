"""Durable deployment admission gate and local activity receipts.

The service's exclusive process lock proves old processes have stopped before
startup recovers abandoned leases. A frozen receipt never asserts that unknown
provider outcomes succeeded, and queued DAG continuations remain intact.
"""

from __future__ import annotations

from collections.abc import Iterator
import contextlib
import contextvars
import json
from typing import TYPE_CHECKING
import uuid

if TYPE_CHECKING:
    import newsletter.store as storage

_CURRENT: contextvars.ContextVar[tuple[DeploymentDrain, str] | None] = (
    contextvars.ContextVar("newsletter_deployment_activity", default=None)
)


def mark_uncertain() -> None:
    """Hold the current activity when local runtime cleanup is unconfirmed."""
    current = _CURRENT.get()
    if current is None:
        return
    gate, lease = current
    with gate.store.transaction():
        gate.store.db.execute(
            "UPDATE deployment_activities SET state='uncertain' WHERE id=?",
            (lease,),
        )


class DrainError(Exception):
    """A safe machine-readable deployment conflict."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class DeploymentDrain:
    """Serialize admission and freeze against the authoritative SQLite owner."""

    def __init__(self, store: storage.Store) -> None:
        self.store = store
        store.db.executescript(
            "CREATE TABLE IF NOT EXISTS deployment_drains ("
            "request_key TEXT PRIMARY KEY, state TEXT NOT NULL, "
            "receipt TEXT);"
            "CREATE TABLE IF NOT EXISTS deployment_activities ("
            "id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL);"
            "CREATE TABLE IF NOT EXISTS deployment_gate ("
            "singleton INTEGER PRIMARY KEY CHECK(singleton=1), "
            "request_key TEXT REFERENCES deployment_drains(request_key));"
            "INSERT OR IGNORE INTO deployment_gate VALUES (1,NULL);"
        )

    def recover(self) -> None:
        """Mark old leases interrupted only under the exclusive process lock."""
        with self.store.transaction():
            self.store.db.execute(
                "UPDATE deployment_activities SET state='interrupted' "
                "WHERE state IN ('active','uncertain')"
            )

    @contextlib.contextmanager
    def activity(self, kind: str, *, required: bool = True) -> Iterator[bool]:
        """Reserve before a claim; finish after its durable effect receipt."""
        lease = str(uuid.uuid4())
        with self.store.transaction():
            blocked = self._active_key() is not None
            if not blocked:
                self.store.db.execute(
                    "INSERT INTO deployment_activities VALUES (?,?,'active')",
                    (lease, kind),
                )
        if blocked:
            if required:
                raise DrainError("deployment_draining")
            yield False
            return
        token = _CURRENT.set((self, lease))
        try:
            yield True
        except BaseException as error:
            with self.store.transaction():
                if isinstance(error, Exception):
                    self.store.db.execute(
                        "DELETE FROM deployment_activities "
                        "WHERE id=? AND state='active'",
                        (lease,),
                    )
                else:
                    self.store.db.execute(
                        "UPDATE deployment_activities SET state='uncertain' "
                        "WHERE id=?",
                        (lease,),
                    )
            raise
        else:
            with self.store.transaction():
                self.store.db.execute(
                    "DELETE FROM deployment_activities "
                    "WHERE id=? AND state='active'",
                    (lease,),
                )
        finally:
            _CURRENT.reset(token)

    def begin(self, key: str) -> dict[str, object]:
        """Close admission durably, returning the same operation on retries."""
        self._validate_key(key)
        with self.store.transaction():
            existing = self._operation(key)
            if existing is not None:
                return existing
            if self._active_key() is not None:
                raise DrainError("deployment_conflict")
            self.store.db.execute(
                "INSERT INTO deployment_drains VALUES (?,'draining',NULL)",
                (key,),
            )
            self.store.db.execute(
                "UPDATE deployment_gate SET request_key=? WHERE singleton=1",
                (key,),
            )
            return self._status(key)

    def freeze(self, key: str) -> dict[str, object]:
        """Freeze after activities and submitting ledgers are empty."""
        self._validate_key(key)
        with self.store.transaction():
            operation = self._operation(key)
            if operation is None or self._active_key() != key:
                raise DrainError("deployment_conflict")
            if operation["state"] == "frozen":
                return operation
            status = self._status(key)
            if status["busy"]:
                raise DrainError("deployment_busy")
            status["state"] = "frozen"
            self.store.db.execute(
                "UPDATE deployment_drains SET state='frozen',receipt=? "
                "WHERE request_key=?",
                (json.dumps(status, sort_keys=True), key),
            )
            return status

    def resume(self, key: str) -> dict[str, object]:
        """Reopen matching admission without resolving interrupted history."""
        self._validate_key(key)
        with self.store.transaction():
            operation = self._operation(key)
            if operation is None:
                raise DrainError("deployment_conflict")
            active = self._active_key()
            if active is not None and active != key:
                raise DrainError("deployment_conflict")
            if operation["state"] != "resumed":
                self.store.db.execute(
                    "UPDATE deployment_drains SET state='resumed' "
                    "WHERE request_key=?",
                    (key,),
                )
                self.store.db.execute(
                    "UPDATE deployment_gate SET request_key=NULL "
                    "WHERE singleton=1"
                )
            return self._status(key)

    def status(self) -> dict[str, object]:
        """Read a consistent, content-free snapshot of the current gate."""
        with self.store.transaction():
            return self._status(self._active_key())

    def _active_key(self) -> str | None:
        row = self.store.db.execute(
            "SELECT request_key FROM deployment_gate WHERE singleton=1"
        ).fetchone()
        return str(row[0]) if row[0] is not None else None

    def _operation(self, key: str) -> dict[str, object] | None:
        row = self.store.db.execute(
            "SELECT state,receipt FROM deployment_drains WHERE request_key=?",
            (key,),
        ).fetchone()
        if row is None:
            return None
        if row[0] == "frozen":
            value: dict[str, object] = json.loads(row[1])
            return value
        return self._status(key)

    def _count(self, table: str, predicate: str) -> int:
        # All callers supply fixed identifiers and predicates, never HTTP data.
        if (
            self.store.db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            is None
        ):
            return 0
        return int(
            self.store.db.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {predicate}"
            ).fetchone()[0]
        )

    def _status(self, key: str | None) -> dict[str, object]:
        state = "active"
        if key is not None:
            state = str(
                self.store.db.execute(
                    "SELECT state FROM deployment_drains WHERE request_key=?",
                    (key,),
                ).fetchone()[0]
            )
        inflight = {
            "activities": self._count(
                "deployment_activities", "state IN ('active','uncertain')"
            ),
            "editions": self._count("editions", "state='running'"),
            "packets": self._count("packets", "projection='submitting'"),
            "workflow_attempts": self._count(
                "workflow_attempts", "state='running'"
            ),
            "notion_entities": self._count(
                "notion_entities", "create_state='creating'"
            ),
            "notion_versions": self._count(
                "notion_versions", "state='appending'"
            ),
            "delivery": self._count(
                "editions", "json_extract(body,'$.delivery_state')='submitting'"
            ),
        }
        unknown = {
            "interrupted_activities": self._count(
                "deployment_activities", "state='interrupted'"
            ),
            "packets": self._count("packets", "projection='unknown'"),
            "workflow_attempts": self._count(
                "workflow_attempts", "state='unknown'"
            ),
            "notion_entities": self._count(
                "notion_entities", "create_state='unknown'"
            ),
            "notion_versions": self._count(
                "notion_versions", "state='unknown'"
            ),
            "delivery": self._count(
                "editions", "json_extract(body,'$.delivery_state')='unknown'"
            ),
        }
        queued = {
            "editions": self._count("editions", "state='queued'"),
            "collection_runs": self._count(
                "collection_runs",
                "state IN ('queued','collecting','projecting','editing')",
            ),
        }
        return {
            "version": 1,
            "request_key": key,
            "state": state,
            "busy": any(inflight.values()),
            "inflight": inflight,
            "unknown": unknown,
            "queued": queued,
        }

    @staticmethod
    def _validate_key(key: str) -> None:
        if not 1 <= len(key) <= 128 or any(
            not 33 <= ord(char) <= 126 for char in key
        ):
            raise DrainError("deployment_invalid_key")
