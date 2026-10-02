"""Durable collection runs and their frozen instruction snapshots."""

from collections.abc import Iterator
import json
from typing import cast
import uuid

import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.types as types


def _decode_object(body: str) -> types.Payload:
    value: object = json.loads(body)
    if not isinstance(value, dict):
        raise newsletter_store.StoreError(
            "invalid_state", "Stored run must be a JSON object"
        )
    return value


class RunRepository:
    """Persist idempotent runs and their exact instruction snapshots."""

    def __init__(self, store: newsletter_store.Store) -> None:
        self.store = store
        with store.lock:
            store.db.execute("""CREATE TABLE IF NOT EXISTS collection_runs (
                id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
                request_hash TEXT NOT NULL, state TEXT NOT NULL,
                body TEXT NOT NULL, instructions TEXT NOT NULL)""")
            store.db.execute(
                "CREATE TABLE IF NOT EXISTS collection_workflow_snapshots (\n"
                "                run_id TEXT PRIMARY KEY, body TEXT NOT NULL)"
            )

    def existing(self, request: types.Payload) -> types.Payload | None:
        """Return a receipt, rejecting request-key reuse with different data."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT request_hash,body FROM collection_runs WHERE "
                "request_key=?",
                (request["request_key"],),
            ).fetchone()
            if row is None:
                return None
            if row["request_hash"] != contracts.content_hash(request):
                raise newsletter_store.StoreError(
                    "conflict", "request_key was used for a different run"
                )
            return _decode_object(row["body"])

    def start(
        self,
        request: types.Payload,
        instructions: list[newsletter_collection_instructions.Instruction],
        *,
        workflow_snapshot: types.Payload | None = None,
    ) -> types.Payload:
        """Atomically queue a bounded run and its frozen execution inputs."""
        with self.store.transaction():
            return self.start_in_transaction(
                request, instructions, workflow_snapshot=workflow_snapshot
            )

    def start_in_transaction(
        self,
        request: types.Payload,
        instructions: list[newsletter_collection_instructions.Instruction],
        *,
        workflow_snapshot: types.Payload | None = None,
    ) -> types.Payload:
        """Create a run inside a caller-owned transaction or continuation."""
        if previous := self.existing(request):
            return previous
        count = self.store.db.execute(
            "SELECT COUNT(*) FROM collection_runs WHERE state IN "
            "('queued','collecting','projecting','editing')"
        ).fetchone()[0]
        if count >= self.store.max_pending_jobs:
            raise newsletter_store.StoreError(
                "busy", "Collection queue is full"
            )
        snapshot = [item.snapshot() for item in instructions]
        at = newsletter_store.now()
        run: types.Payload = {
            "id": str(uuid.uuid4()),
            "issue_date": request["issue_date"],
            "state": "queued",
            "instructions_hash": contracts.content_hash(snapshot),
            "directions": [
                {
                    "id": item.id,
                    "instruction_hash": item.digest,
                    "state": "queued",
                    "packet_ids": [],
                    "note": "",
                }
                for item in instructions
            ],
            "edition_id": "",
            "error_code": "",
            "created_at": at,
            "updated_at": at,
            "is_fixture": self.store.mode == "mock",
        }
        self.store.db.execute(
            "INSERT INTO collection_runs VALUES (?,?,?,?,?,?)",
            (
                run["id"],
                request["request_key"],
                contracts.content_hash(request),
                run["state"],
                contracts.canonical_json(run),
                contracts.canonical_json(snapshot),
            ),
        )
        if workflow_snapshot is not None:
            self.store.db.execute(
                "INSERT INTO collection_workflow_snapshots VALUES(?,?)",
                (run["id"], contracts.canonical_json(workflow_snapshot)),
            )
        return run

    def workflow_snapshot(self, run_id: str) -> types.Payload | None:
        """Read the frozen DAG snapshot; absence denotes a legacy run."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT body FROM collection_workflow_snapshots WHERE run_id=?",
                (run_id,),
            ).fetchone()
        return _decode_object(row[0]) if row else None

    def instruction_snapshot(self, run_id: str) -> list[types.Payload]:
        """Read exact stored instructions for a source-run integrity audit."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT instructions FROM collection_runs WHERE id=?",
                (run_id,),
            ).fetchone()
        if row is None:
            raise newsletter_store.StoreError("not_found", "Run not found")
        return cast(list[types.Payload], json.loads(row[0]))

    def queued_collecting(self) -> Iterator[types.Payload]:
        """Yield the locked snapshot of deadline-sensitive collection runs.

        Decode one receipt at a time so an early successful priority check does
        not inspect unrelated later runs.
        """
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT body FROM collection_runs WHERE state IN "
                "('queued','collecting')"
            ).fetchall()
        for row in rows:
            yield cast(types.Payload, json.loads(row[0]))

    def legacy_repair_candidates(self) -> Iterator[types.Payload]:
        """Read recent blocked runs only while the pending queue has capacity.

        The count and candidate query share one process lock. This is a scan,
        not a reservation; starting a repair still checks queue capacity.
        """
        with self.store.lock:
            pending = self.store.db.execute(
                "SELECT COUNT(*) FROM collection_runs WHERE state IN "
                "('queued','collecting','projecting','editing')"
            ).fetchone()[0]
            if pending >= self.store.max_pending_jobs:
                return
            rows = self.store.db.execute(
                "SELECT body FROM collection_runs WHERE state='blocked' "
                "ORDER BY rowid DESC LIMIT 100"
            ).fetchall()
        for row in rows:
            yield cast(types.Payload, json.loads(row[0]))

    def get(self, run_id: str) -> types.Payload:
        """Read a run receipt or raise not_found without constructing a run."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT body FROM collection_runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise newsletter_store.StoreError("not_found", "Run not found")
            return _decode_object(row[0])

    def _write(self, run: types.Payload) -> None:
        run["updated_at"] = newsletter_store.now()
        self.store.db.execute(
            "UPDATE collection_runs SET state=?,body=? WHERE id=?",
            (run["state"], contracts.canonical_json(run), run["id"]),
        )

    def update(self, run_id: str, **fields: object) -> types.Payload:
        """Apply state transitions and persist the receipt atomically."""
        with self.store.transaction():
            run = self.get(run_id)
            run.update(fields)
            self._write(run)
            return run

    def direction(
        self, run_id: str, direction_id: str, **fields: object
    ) -> None:
        """Update one direction within its parent run's transaction."""
        with self.store.transaction():
            run = self.get(run_id)
            direction = next(
                d for d in run["directions"] if d["id"] == direction_id
            )
            direction.update(fields)
            self._write(run)

    def claim(
        self, *, resume: bool = False
    ) -> (
        tuple[
            types.Payload, list[newsletter_collection_instructions.Instruction]
        ]
        | None
    ):
        """Claim the oldest eligible run, preserving its stored instructions."""
        with self.store.transaction():
            row = self.store.db.execute(
                "SELECT body,instructions FROM collection_runs WHERE state "
                "IN ('queued','collecting') ORDER BY rowid LIMIT 1"
                if resume
                else "SELECT body,instructions FROM collection_runs WHERE "
                "state='queued' ORDER BY rowid LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            run = json.loads(row["body"])
            run["state"] = "collecting"
            self._write(run)
            return run, [
                newsletter_collection_instructions.Instruction(**item)
                for item in json.loads(row["instructions"])
            ]

    def save_direction(
        self,
        run_id: str,
        direction_id: str,
        requests: list[types.Payload],
        note: str,
    ) -> None:
        """Commit validated materials and their run association atomically."""
        with self.store.transaction():
            packet_ids = [
                self.store.put_packet_in_transaction(request, "collector")["id"]
                for request in requests
            ]
            run = self.get(run_id)
            direction = next(
                d for d in run["directions"] if d["id"] == direction_id
            )
            direction.update(
                state="collected" if packet_ids else "no_findings",
                packet_ids=packet_ids,
                note=note,
            )
            self._write(run)

    def active(self) -> list[types.Payload]:
        """Read legacy runs awaiting projection or edition completion."""
        with self.store.lock:
            return [
                json.loads(row[0])
                for row in self.store.db.execute(
                    "SELECT body FROM collection_runs WHERE state IN "
                    "('projecting','editing') ORDER BY rowid"
                ).fetchall()
            ]

    def recover(self) -> None:
        """Reconcile interrupted work without repeating provider calls."""
        # Never reissue an interrupted model request or ambiguous Notion write.
        with self.store.transaction():
            rows = self.store.db.execute(
                "SELECT body FROM collection_runs WHERE state='collecting'"
            ).fetchall()
            for row in rows:
                run = json.loads(row[0])
                if self.workflow_snapshot(run["id"]):
                    # DAG attempts decide whether work is safe to resume;
                    # already
                    # completed stages are immutable, in-flight attempts become
                    # unknown.
                    run.update(state="queued", error_code="")
                    self._write(run)
                    continue
                run.update(state="failed", error_code="collection_interrupted")
                for direction in run["directions"]:
                    if direction["state"] == "collecting":
                        direction["state"] = "failed"
                self._write(run)

    def projection_states(self, packet_ids: list[str]) -> list[str]:
        """Read durable projection outcomes without calling providers."""
        with self.store.lock:
            states = []
            for packet_id in packet_ids:
                row = self.store.db.execute(
                    "SELECT projection FROM packets WHERE id=?", (packet_id,)
                ).fetchone()
                states.append(row[0] if row else "failed")
            return states
