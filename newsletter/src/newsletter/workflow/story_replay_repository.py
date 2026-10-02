"""Durable one-child story restart receipts, separate from eligibility policy.

The caller owns the transaction spanning source audits, child creation, and
receipt insertion. Reads preserve stored bytes for the domain hash checks.
"""

from typing import cast, TypedDict

import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.types as types


class ReplayRecord(TypedDict):
    """Stored identities, exact receipt JSON, and its independent digest."""

    parent_run_id: str
    child_run_id: str
    request_key: str
    body: str
    digest: str


class StoryReplayRepository:
    """Persist one immutable restart receipt per parent and child."""

    def __init__(self, store: newsletter_store.Store) -> None:
        self.store = store
        with store.lock:
            store.db.execute(
                "CREATE TABLE IF NOT EXISTS workflow_story_replays "
                "(parent_run_id TEXT PRIMARY KEY, child_run_id TEXT "
                "UNIQUE NOT NULL, request_key TEXT UNIQUE NOT NULL, "
                "body TEXT NOT NULL, digest TEXT NOT NULL)"
            )

    def parent_record(self, parent_id: str) -> ReplayRecord | None:
        """Read a parent's original restart receipt without interpreting it."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT * FROM workflow_story_replays WHERE parent_run_id=?",
                (parent_id,),
            ).fetchone()
        return cast(ReplayRecord, dict(row)) if row is not None else None

    def child_record(self, child_id: str) -> ReplayRecord | None:
        """Read the receipt authorizing a child's exact upstream reuse."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT * FROM workflow_story_replays WHERE child_run_id=?",
                (child_id,),
            ).fetchone()
        return cast(ReplayRecord, dict(row)) if row is not None else None

    def is_child(self, run_id: str) -> bool:
        """Check whether a run already consumes its parent's single restart."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT 1 FROM workflow_story_replays WHERE child_run_id=?",
                (run_id,),
            ).fetchone()
        return row is not None

    def save_in_transaction(self, receipt: types.Payload) -> None:
        """Insert a receipt in the caller's child-creation transaction.

        The caller must hold Store.transaction() across eligibility checks and
        run insertion. Unique constraints prevent competing or recursive
        restarts; this method never replaces an existing receipt.
        """
        self.store.db.execute(
            "INSERT INTO workflow_story_replays VALUES(?,?,?,?,?)",
            (
                receipt["parent_run_id"],
                receipt["child_run_id"],
                receipt["request"]["request_key"],
                contracts.canonical_json(receipt),
                contracts.content_hash(receipt),
            ),
        )
