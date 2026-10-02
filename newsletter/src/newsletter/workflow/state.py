"""Store durable ledgers for nodes and the protected publication tail."""

from __future__ import annotations

from collections.abc import Callable
import json
import re
import sqlite3
from typing import cast

import newsletter.contracts as contracts
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.usage as newsletter_usage
import newsletter.workflow.definition as newsletter_workflow_definition

MAX_REPAIR_SNAPSHOT_BYTES = 2 * 1024 * 1024
_REPAIR_SUFFIX = ":repair-1"
_ID = re.compile(contracts.IDENTIFIER_PATTERN + r"\Z")


def _repair_record(row: sqlite3.Row) -> types.Payload:
    return {
        "parent_run_id": row["parent_run_id"],
        "source_edition_id": row["source_edition_id"],
        "child_run_id": row["child_run_id"],
        "snapshot": json.loads(row["snapshot"]),
    }


def usage_records(
    store: newsletter_store.Store, scope_id: str
) -> list[newsletter_usage.UsageRecord]:
    """Read exact records for one scope without creating tables or lineage.

    Startup-replay eligibility inspects the original attempts, not an aggregate
    or a parent/child total. Missing reports remain missing, never zero usage.
    """
    with store.lock:
        rows = store.db.execute(
            "SELECT body FROM model_usage WHERE scope_id=?", (scope_id,)
        ).fetchall()
    return [
        cast(newsletter_usage.UsageRecord, json.loads(row[0])) for row in rows
    ]


class WorkflowState:
    """Store usage, history and frozen publication or repair bindings."""

    def __init__(self, store: newsletter_store.Store) -> None:
        self.store = store
        with store.lock:
            store.db.executescript(
                "\n"
                "                CREATE TABLE IF NOT EXISTS model_usage (\n"
                "                    invocation_id TEXT PRIMARY KEY, "
                "scope_id TEXT NOT NULL,\n"
                "                    body TEXT NOT NULL, updated_at TEXT "
                "NOT NULL);\n"
                "                CREATE INDEX IF NOT EXISTS "
                "model_usage_scope ON model_usage(scope_id);\n"
                "                CREATE TABLE IF NOT EXISTS "
                "candidate_history (\n"
                "                    id TEXT PRIMARY KEY, body TEXT NOT "
                "NULL,\n"
                "                    first_seen TEXT NOT NULL, last_seen "
                "TEXT NOT NULL,\n"
                "                    disposition TEXT NOT NULL, reason "
                "TEXT NOT NULL);\n"
                "                CREATE TABLE IF NOT EXISTS "
                "workflow_editions (\n"
                "                    edition_id TEXT PRIMARY KEY, run_id "
                "TEXT UNIQUE NOT NULL,\n"
                "                    editor_result TEXT NOT NULL, "
                "required_packets TEXT NOT NULL);\n"
                "                CREATE TABLE IF NOT EXISTS "
                "workflow_archives (\n"
                "                    run_id TEXT PRIMARY KEY, state TEXT "
                "NOT NULL,\n"
                "                    packet_id TEXT NOT NULL, error_code "
                "TEXT NOT NULL);\n"
                "                CREATE TABLE IF NOT EXISTS "
                "workflow_repairs (\n"
                "                    parent_run_id TEXT PRIMARY KEY, "
                "source_edition_id TEXT NOT NULL,\n"
                "                    child_run_id TEXT UNIQUE NOT NULL, "
                "snapshot TEXT NOT NULL);\n"
                "            "
            )

    def usage_sink(
        self, scope_id: str
    ) -> Callable[[newsletter_usage.UsageRecord], None]:
        """Build a durable invocation recorder bound to one immutable scope."""

        def save(record: newsletter_usage.UsageRecord) -> None:
            with self.store.transaction():
                previous = self.store.db.execute(
                    "SELECT scope_id FROM model_usage WHERE invocation_id=?",
                    (record["id"],),
                ).fetchone()
                if previous is not None and previous[0] != scope_id:
                    raise newsletter_store.StoreError(
                        "conflict", "Usage scope cannot change"
                    )
                self.store.db.execute(
                    (
                        "INSERT INTO model_usage VALUES (?,?,?,?) ON "
                        "CONFLICT(invocation_id) DO UPDATE SET "
                        "body=excluded.body,updated_at=excluded.updated_at"
                    ),
                    (
                        record["id"],
                        scope_id,
                        contracts.canonical_json(record),
                        newsletter_store.now(),
                    ),
                )

        return save

    def usage(self, scope_id: str) -> newsletter_usage.UsageSummary:
        """Summarize usage across a run and its audited repair lineage."""
        with self.store.lock:
            family = self.store.db.execute(
                "SELECT parent_run_id,child_run_id FROM workflow_repairs "
                "WHERE parent_run_id=? OR child_run_id=?",
                (scope_id, scope_id),
            ).fetchone()
            scopes = set(family) if family is not None else {scope_id}
            if self.store.db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND "
                "name='workflow_story_replays'"
            ).fetchone():
                lineage = self.store.db.execute(
                    "SELECT parent_run_id,child_run_id "
                    "FROM workflow_story_replays "
                    "WHERE parent_run_id=? OR child_run_id=?",
                    (scope_id, scope_id),
                ).fetchone()
                if lineage is not None:
                    scopes.update(lineage)
            placeholders = ",".join("?" for _ in scopes)
            records = self.store.db.execute(
                "SELECT body FROM model_usage "
                f"WHERE scope_id IN ({placeholders}) ORDER BY rowid",
                sorted(scopes),
            ).fetchall()
        return newsletter_usage.summarize_usage(
            [
                cast(newsletter_usage.UsageRecord, json.loads(row[0]))
                for row in records
            ]
        )

    def repair(self, parent_run_id: str) -> types.Payload | None:
        """Read the immutable repair receipt for a parent run, if present."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT * FROM workflow_repairs WHERE parent_run_id=?",
                (parent_run_id,),
            ).fetchone()
        return _repair_record(row) if row is not None else None

    def create_repair(
        self,
        parent_run_id: str,
        source_edition_id: str,
        definition: types.Payload,
        inputs: types.Payload,
    ) -> types.Payload:
        """Freeze one repair without changing its blocked source or artifacts.

        A repeated identical request retrieves the existing receipt even after
        publication; it does not grant a second attempt or rewrite any state.
        """
        if any(
            not isinstance(value, str) or not _ID.fullmatch(value)
            for value in (parent_run_id, source_edition_id)
        ):
            raise newsletter_store.StoreError(
                "invalid_argument", "Invalid repair identity"
            )
        child_run_id = parent_run_id + _REPAIR_SUFFIX
        if not _ID.fullmatch(child_run_id):
            raise newsletter_store.StoreError(
                "invalid_argument", "Invalid repair identity"
            )
        try:
            if not isinstance(definition, dict) or not isinstance(inputs, dict):
                raise ValueError
            newsletter_workflow_definition.parse_definition(definition)
            encoded = contracts.canonical_json(
                {"definition": definition, "inputs": inputs}
            )
            if len(encoded.encode("utf-8")) > MAX_REPAIR_SNAPSHOT_BYTES:
                raise ValueError
            snapshot = json.loads(encoded)  # Detach caller-owned mutable data.
        except (TypeError, ValueError, RecursionError, OverflowError):
            raise newsletter_store.StoreError(
                "invalid_argument", "Invalid repair snapshot"
            ) from None
        with self.store.transaction():
            if (
                parent_run_id.endswith(_REPAIR_SUFFIX)
                or self.store.db.execute(
                    "SELECT 1 FROM workflow_repairs WHERE child_run_id=?",
                    (parent_run_id,),
                ).fetchone()
            ):
                raise newsletter_store.StoreError(
                    "conflict", "A repair cannot be repaired again"
                )
            previous = self.store.db.execute(
                "SELECT * FROM workflow_repairs WHERE parent_run_id=?",
                (parent_run_id,),
            ).fetchone()
            if previous is not None:
                if (
                    previous["source_edition_id"] != source_edition_id
                    or previous["snapshot"] != encoded
                ):
                    raise newsletter_store.StoreError(
                        "conflict", "Frozen repair cannot change"
                    )
                return _repair_record(previous)
            collection_exists = self.store.db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND "
                "name='collection_runs'"
            ).fetchone()
            parent_row = (
                self.store.db.execute(
                    "SELECT state,body FROM collection_runs WHERE id=?",
                    (parent_run_id,),
                ).fetchone()
                if collection_exists
                else None
            )
            if parent_row is None:
                raise newsletter_store.StoreError(
                    "not_found", "Repair source run does not exist"
                )
            parent = json.loads(parent_row["body"])
            source_row = self.store.db.execute(
                "SELECT state,body FROM editions WHERE id=?",
                (source_edition_id,),
            ).fetchone()
            source = (
                json.loads(source_row["body"]) if source_row is not None else {}
            )
            binding = self.store.db.execute(
                "SELECT run_id FROM workflow_editions WHERE edition_id=?",
                (source_edition_id,),
            ).fetchone()
            review = source.get("review")
            if (
                parent_row["state"] != "blocked"
                or parent.get("state") != "blocked"
                or parent.get("edition_id") != source_edition_id
                or parent.get("error_code") != "editorial_review_failed"
                or source_row is None
                or source_row["state"] != "blocked"
                or source.get("state") != "blocked"
                or not isinstance(review, dict)
                or review.get("passed") is not False
                or binding is None
                or binding["run_id"] != parent_run_id
                or source.get("delivery_state") != "not_requested"
                or source.get("issue_date") != parent.get("issue_date")
                or snapshot["inputs"].get("issue_date")
                != source.get("issue_date")
                or self.store.db.execute(
                    "SELECT 1 FROM sends WHERE issue_date=?",
                    (source.get("issue_date"),),
                ).fetchone()
            ):
                raise newsletter_store.StoreError(
                    "conflict",
                    "Repair requires an unsent edition blocked by review",
                )
            self.store.db.execute(
                "INSERT INTO workflow_repairs VALUES(?,?,?,?)",
                (parent_run_id, source_edition_id, child_run_id, encoded),
            )
        return {
            "parent_run_id": parent_run_id,
            "source_edition_id": source_edition_id,
            "child_run_id": child_run_id,
            "snapshot": snapshot,
        }

    def archive_result(
        self, run_id: str, *, packet_id: str = "", error_code: str = ""
    ) -> None:
        """Record a queued archive packet or a finite archive failure."""
        with self.store.transaction():
            self.store.db.execute(
                (
                    "INSERT INTO workflow_archives VALUES(?,?,?,?) ON "
                    "CONFLICT(run_id) DO UPDATE SET "
                    "state=excluded.state,packet_id=excluded.packet_id,erro"
                    "r_code=excluded.error_code"
                ),
                (
                    run_id,
                    "failed" if error_code else "queued",
                    packet_id,
                    error_code,
                ),
            )

    def remember(
        self, candidates: list[types.Payload], issue_date: str
    ) -> None:
        """Upsert candidate metadata without changing its first-seen date."""
        with self.store.transaction():
            for candidate in candidates:
                self.store.db.execute(
                    (
                        "INSERT INTO candidate_history VALUES(?,?,?,?,?,?) "
                        "ON CONFLICT(id) DO UPDATE SET "
                        "body=excluded.body,last_seen=excluded.last_seen"
                    ),
                    (
                        candidate["id"],
                        contracts.canonical_json(candidate),
                        issue_date,
                        issue_date,
                        "seen",
                        "",
                    ),
                )

    def history(self, issue_date: str, limit: int = 90) -> list[types.Payload]:
        """Read bounded candidate history strictly before the issue date."""
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT * FROM candidate_history WHERE first_seen<? "
                "ORDER BY last_seen DESC,id LIMIT ?",
                (issue_date, min(limit, 120)),
            ).fetchall()
        return [
            {
                **json.loads(row["body"]),
                "first_seen": row["first_seen"],
                "last_seen": row["last_seen"],
                "disposition": row["disposition"],
                "selection_reason": row["reason"],
            }
            for row in rows
        ]

    def mark(self, ids: list[str], disposition: str, reason: str = "") -> None:
        """Set a finite disposition and bounded reason for known candidates."""
        if disposition not in {"seen", "researched", "used", "watch"}:
            raise ValueError("Invalid candidate disposition")
        with self.store.transaction():
            self.store.db.executemany(
                (
                    "UPDATE candidate_history SET disposition=?,reason=? "
                    "WHERE id=?"
                ),
                [(disposition, reason[:2000], item) for item in ids],
            )

    def bind_edition(
        self,
        edition_id: str,
        run_id: str,
        result: types.Payload,
        required_packets: list[str],
        *,
        projection_required: bool = True,
    ) -> None:
        """Freeze an edition binding or verify an identical repeated request."""
        if type(projection_required) is not bool:
            raise newsletter_store.StoreError(
                "invalid_argument", "Invalid projection policy"
            )
        encoded = contracts.canonical_json(result)
        required = contracts.canonical_json(sorted(set(required_packets)))
        with self.store.transaction():
            previous = self.store.db.execute(
                (
                    "SELECT run_id,editor_result,required_packets,projectio"
                    "n_required FROM workflow_editions WHERE edition_id=?"
                ),
                (edition_id,),
            ).fetchone()
            if previous is not None:
                if tuple(previous) != (
                    run_id,
                    encoded,
                    required,
                    int(projection_required),
                ):
                    raise newsletter_store.StoreError(
                        "conflict", "Frozen workflow edition cannot change"
                    )
                return
            self.store.db.execute(
                (
                    "INSERT INTO workflow_editions(edition_id,run_id,editor"
                    "_result,required_packets,projection_required) "
                    "VALUES(?,?,?,?,?)"
                ),
                (
                    edition_id,
                    run_id,
                    encoded,
                    required,
                    int(projection_required),
                ),
            )

    def edition(self, edition_id: str) -> types.Payload | None:
        """Read the frozen workflow binding associated with an edition."""
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT * FROM workflow_editions WHERE edition_id=?",
                (edition_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "run_id": row["run_id"],
            "result": json.loads(row["editor_result"]),
            "required_packets": json.loads(row["required_packets"]),
            "projection_required": bool(row["projection_required"]),
        }

    def assert_publishable(self, edition_id: str) -> None:
        """Require bound research to satisfy publication barriers."""
        self.store.assert_workflow_research(edition_id)
