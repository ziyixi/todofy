"""Authoritative SQLite state without implicit external side-effect retries."""

import base64
from collections.abc import Iterator
import contextlib
import datetime
import json
import pathlib
import sqlite3
import threading
from typing import cast, Unpack
import uuid

import newsletter.contracts as contracts
import newsletter.drain as drain
import newsletter.types as types


class StoreError(Exception):
    """A safe domain code and explanation for a rejected state transition."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def now() -> str:
    """Return a timezone-aware UTC timestamp for durable local records."""
    return datetime.datetime.now(datetime.UTC).isoformat()


# Versioned name of a one-time data migration, recorded in metadata.
_SETTLED_ATTEMPTS_MIGRATION = "migration:settle_read_only_attempts:v1"


class Store:
    """Own packet, edition, and send receipts in a mode-bound SQLite database.

    Mutations use an immediate transaction and a reentrant process lock. A
    claimed external effect remains durable until explicitly resolved; startup
    recovery never treats an ambiguous send as permission to dispatch again.
    """

    def __init__(
        self, path: pathlib.Path, mode: str, max_pending_jobs: int = 8
    ) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(
            path, check_same_thread=False, isolation_level=None
        )
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.max_pending_jobs = max_pending_jobs
        self.db.executescript(
            "\n"
            "            PRAGMA journal_mode=WAL;\n"
            "            PRAGMA foreign_keys=ON;\n"
            "            PRAGMA busy_timeout=5000;\n"
            "            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY "
            "KEY, value TEXT NOT NULL);\n"
            "            CREATE TABLE IF NOT EXISTS packets (\n"
            "                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT "
            "UNIQUE NOT NULL,\n"
            "                principal TEXT NOT NULL, request_key TEXT NOT "
            "NULL, digest TEXT NOT NULL,\n"
            "                body TEXT NOT NULL, projection TEXT NOT NULL "
            "DEFAULT 'pending',\n"
            "                UNIQUE(principal, request_key));\n"
            "            CREATE TABLE IF NOT EXISTS editions (\n"
            "                id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT "
            "NULL, digest TEXT NOT NULL,\n"
            "                state TEXT NOT NULL, body TEXT NOT NULL, snapshot "
            "TEXT NOT NULL);\n"
            "            CREATE TABLE IF NOT EXISTS sends (\n"
            "                issue_date TEXT PRIMARY KEY, edition_id TEXT "
            "UNIQUE NOT NULL,\n"
            "                request_key TEXT UNIQUE NOT NULL, render_hash "
            "TEXT NOT NULL);\n"
            "            CREATE TABLE IF NOT EXISTS verification_sends (\n"
            "                issue_date TEXT NOT NULL, edition_id TEXT PRIMARY "
            "KEY NOT NULL,\n"
            "                request_key TEXT UNIQUE NOT NULL, render_hash "
            "TEXT NOT NULL,\n"
            "                previous_edition_id TEXT UNIQUE NOT NULL, "
            "created_at TEXT NOT NULL);\n"
            "            CREATE TABLE IF NOT EXISTS workflow_editions (\n"
            "                edition_id TEXT PRIMARY KEY, run_id TEXT UNIQUE "
            "NOT NULL,\n"
            "                editor_result TEXT NOT NULL, required_packets "
            "TEXT NOT NULL,\n"
            "                projection_required INTEGER NOT NULL DEFAULT 1);\n"
            "        "
        )
        with self.transaction():
            verification_columns = {
                row["name"]: row
                for row in self.db.execute(
                    "PRAGMA table_info(verification_sends)"
                )
            }
            if verification_columns["issue_date"]["pk"]:
                # Preserve every receipt while allowing an explicitly approved
                # successor. The unique predecessor forbids branching, even
                # across concurrent app processes. DDL/copy are one transaction.
                self.db.execute(
                    "CREATE TABLE verification_sends_migrated ("
                    "issue_date TEXT NOT NULL, edition_id TEXT PRIMARY KEY "
                    "NOT NULL, "
                    "request_key TEXT UNIQUE NOT NULL, render_hash TEXT "
                    "NOT NULL, "
                    "previous_edition_id TEXT UNIQUE NOT NULL, created_at "
                    "TEXT NOT NULL)"
                )
                self.db.execute(
                    "INSERT INTO verification_sends_migrated "
                    "(issue_date,edition_id,request_key,render_hash,previou"
                    "s_edition_id,created_at) "
                    "SELECT issue_date,edition_id,request_key,render_hash,p"
                    "revious_edition_id,"
                    "created_at FROM verification_sends"
                )
                self.db.execute("DROP TABLE verification_sends")
                self.db.execute(
                    "ALTER TABLE verification_sends_migrated RENAME TO "
                    "verification_sends"
                )
            self.db.execute(
                "CREATE INDEX IF NOT EXISTS verification_sends_date ON "
                "verification_sends(issue_date)"
            )
            columns = {
                row["name"]
                for row in self.db.execute(
                    "PRAGMA table_info(workflow_editions)"
                )
            }
            if "projection_required" not in columns:
                self.db.execute(
                    "ALTER TABLE workflow_editions ADD COLUMN "
                    "projection_required INTEGER NOT NULL DEFAULT 1"
                )
            row = self.db.execute(
                "SELECT value FROM metadata WHERE key='mode'"
            ).fetchone()
            if row and row[0] != mode:
                raise ValueError(
                    "Do not reuse mock storage for live publication"
                )
            self.db.execute(
                "INSERT OR IGNORE INTO metadata VALUES ('mode', ?)", (mode,)
            )
            self._settle_read_only_attempts()
        self.mode = mode
        self.deployment = drain.DeploymentDrain(self)

    def _settle_read_only_attempts(self) -> None:
        """Mark old timed-out or interrupted node attempts as failed, once.

        Earlier releases stored these as 'unknown', which the monitor reports
        as records awaiting reconciliation. Workflow nodes are read-only:
        Codex runs with a read-only sandbox and no approvals, while delivery
        and Notion keep their own ledgers. Such an attempt has nothing left to
        reconcile, so it is a known failure; this release's engine and restart
        recovery record new ones as failed directly. The error code, run
        receipts and every other ledger stay untouched. The named marker makes
        this run exactly once, so an unknown recorded by a later release is
        never rewritten by a restart. The caller owns the transaction.
        """
        if self.db.execute(
            "SELECT 1 FROM metadata WHERE key=?",
            (_SETTLED_ATTEMPTS_MIGRATION,),
        ).fetchone():
            return
        changed = 0
        if self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='workflow_attempts'"
        ).fetchone():
            changed = self.db.execute(
                "UPDATE workflow_attempts SET state='failed' "
                "WHERE state='unknown' "
                "AND error_code IN ('timeout','interrupted')"
            ).rowcount
        self.db.execute(
            "INSERT INTO metadata VALUES (?, ?)",
            (
                _SETTLED_ATTEMPTS_MIGRATION,
                json.dumps({"applied_at": now(), "changed": changed}),
            ),
        )

    @contextlib.contextmanager
    def transaction(self) -> Iterator[None]:
        """Lock and commit one transaction, rolling back on any interruption.

        Callers must not nest this context; use an in-transaction method when
        a larger operation already owns the transaction and process lock.
        """
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def close(self) -> None:
        """Close the database after its workers have stopped using it."""
        self.db.close()

    def bind_delivery_target(self, target: dict[str, str]) -> None:
        """Bind a database to one immutable audience and delivery provider."""
        digest = contracts.content_hash(target)
        with self.transaction():
            row = self.db.execute(
                "SELECT value FROM metadata WHERE key='delivery_target'"
            ).fetchone()
            if row and row[0] != digest:
                raise ValueError(
                    "Delivery target changed; use a new data directory"
                )
            self.db.execute(
                "INSERT OR IGNORE INTO metadata VALUES ('delivery_target', ?)",
                (digest,),
            )

    def save_supplements(
        self, edition_id: str, packets: list[types.Payload]
    ) -> None:
        """Save research already validated by the trusted worker."""
        with self.transaction():
            row = self.db.execute(
                "SELECT snapshot FROM editions WHERE id=?", (edition_id,)
            ).fetchone()
            snapshot = json.loads(row[0])
            edition = self.get(edition_id)
            for packet in packets:
                if self.db.execute(
                    "SELECT 1 FROM packets WHERE id=?", (packet["id"],)
                ).fetchone():
                    raise StoreError(
                        "conflict", "Supplemental packet ID is already in use"
                    )
                self.db.execute(
                    "INSERT INTO packets(id,principal,request_key,digest,bo"
                    "dy) VALUES(?,?,?,?,?)",
                    (
                        packet["id"],
                        "editor",
                        edition_id + ":" + packet["id"],
                        contracts.content_hash(packet["content"]),
                        contracts.canonical_json(packet),
                    ),
                )
                snapshot.append(packet)
                edition["packet_ids"].append(packet["id"])
            self.db.execute(
                "UPDATE editions SET snapshot=? WHERE id=?",
                (contracts.canonical_json(snapshot), edition_id),
            )
            self._write(edition)

    def put_packet(
        self, request: types.Payload, principal: str = "producer"
    ) -> types.Payload:
        """Atomically insert material or return its identical prior receipt."""
        with self.transaction():
            return self.put_packet_in_transaction(request, principal)

    def save_workflow_supplements(
        self, run_id: str, packets: list[types.Payload]
    ) -> None:
        """Preserve validated citation IDs before the DAG artifact is final."""
        with self.transaction():
            for packet in packets:
                previous = self.db.execute(
                    "SELECT body FROM packets WHERE id=?", (packet["id"],)
                ).fetchone()
                body = contracts.canonical_json(packet)
                if previous is not None:
                    if previous[0] != body:
                        raise StoreError(
                            "conflict", "Research packet identity cannot change"
                        )
                    continue
                self.db.execute(
                    "INSERT INTO packets(id,principal,request_key,digest,bo"
                    "dy) VALUES(?,?,?,?,?)",
                    (
                        packet["id"],
                        "workflow-editor",
                        run_id + ":" + packet["id"],
                        contracts.content_hash(packet["content"]),
                        body,
                    ),
                )

    def put_packet_in_transaction(
        self, request: types.Payload, principal: str
    ) -> types.Payload:
        """Insert material inside a transaction already owned by the caller.

        The caller must hold ``transaction()`` so packet insertion and the
        surrounding collection receipt commit together. Conflicting reuse of
        a principal's request key raises StoreError without replacing data.
        """
        digest = contracts.content_hash(request)
        row = self.db.execute(
            "SELECT digest, body FROM packets WHERE principal=? AND "
            "request_key=?",
            (principal, request["request_key"]),
        ).fetchone()
        if row:
            if row["digest"] != digest:
                raise StoreError(
                    "conflict", "request_key was used for different material"
                )
            return cast(types.Payload, json.loads(row["body"]))
        packet = {
            "id": str(uuid.uuid4()),
            "workflow_id": request["workflow_id"],
            "producer_id": principal,
            "content": request["content"],
            "content_hash": contracts.content_hash(request["content"]),
            "created_at": now(),
            "is_fixture": self.mode == "mock",
        }
        self.db.execute(
            "INSERT INTO packets(id,principal,request_key,digest,body) "
            "VALUES(?,?,?,?,?)",
            (
                packet["id"],
                principal,
                request["request_key"],
                digest,
                contracts.canonical_json(packet),
            ),
        )
        return packet

    def read_inbox(self, limit: int = 20, cursor: str = "") -> types.Payload:
        """Return a descending packet page and an opaque continuation cursor."""
        with self.lock:
            top = self.db.execute(
                "SELECT COALESCE(MAX(seq),0) FROM packets"
            ).fetchone()[0]
            before = top + 1
            if cursor:
                try:
                    top, before = json.loads(base64.urlsafe_b64decode(cursor))
                    if any(
                        type(v) is not int or not 0 <= v <= 2**63 - 1
                        for v in (top, before)
                    ):
                        raise ValueError()
                except (ValueError, TypeError, KeyError):
                    raise StoreError(
                        "invalid_argument", "Invalid inbox cursor"
                    ) from None
            rows = self.db.execute(
                "SELECT seq,body FROM packets WHERE seq<=? AND seq<? ORDER "
                "BY seq DESC LIMIT ?",
                (top, before, limit + 1),
            ).fetchall()
            selected = rows[:limit]
            next_cursor = ""
            if len(rows) > limit:
                next_cursor = base64.urlsafe_b64encode(
                    json.dumps([top, selected[-1]["seq"]]).encode()
                ).decode()
            return {
                "packets": [json.loads(r["body"]) for r in selected],
                "next_cursor": next_cursor,
            }

    def prepare(
        self,
        request: types.Payload,
        *,
        workflow_binding: types.Payload | None = None,
    ) -> types.EditionRecord:
        """Queue an edition with immutable packet and workflow input bindings.

        Reusing an identical request returns its prior edition. Invalid packet
        selection, queue exhaustion, or conflicting request keys fail before
        any partial snapshot becomes visible.
        """
        digest = contracts.content_hash(request)
        if (
            workflow_binding is not None
            and type(workflow_binding.get("projection_required", True))
            is not bool
        ):
            raise StoreError(
                "invalid_argument",
                "Projection policy must be an explicit boolean",
            )
        with self.transaction():
            row = self.db.execute(
                "SELECT digest,body FROM editions WHERE request_key=?",
                (request["request_key"],),
            ).fetchone()
            if row:
                if row["digest"] != digest:
                    raise StoreError(
                        "conflict", "request_key was used for another edition"
                    )
                existing = cast(types.EditionRecord, json.loads(row["body"]))
                if workflow_binding is not None:
                    binding = self.db.execute(
                        "SELECT run_id,editor_result,required_packets,proje"
                        "ction_required "
                        "FROM workflow_editions WHERE edition_id=?",
                        (existing["id"],),
                    ).fetchone()
                    expected = (
                        workflow_binding["run_id"],
                        contracts.canonical_json(workflow_binding["result"]),
                        contracts.canonical_json(
                            sorted(set(workflow_binding["required_packets"]))
                        ),
                        int(workflow_binding.get("projection_required", True)),
                    )
                    if binding is None or tuple(binding) != expected:
                        raise StoreError(
                            "conflict", "Frozen workflow edition cannot change"
                        )
                return existing
            if (
                self.db.execute(
                    "SELECT COUNT(*) FROM editions WHERE state IN "
                    "('queued','running')"
                ).fetchone()[0]
                >= self.max_pending_jobs
            ):
                raise StoreError("busy", "Editorial queue is full")
            packets = []
            for packet_id in request["packet_ids"]:
                row = self.db.execute(
                    "SELECT body FROM packets WHERE id=?", (packet_id,)
                ).fetchone()
                if not row:
                    raise StoreError(
                        "not_found", "One or more packets do not exist"
                    )
                packets.append(json.loads(row[0]))
            at = now()
            edition: types.EditionRecord = {
                "id": str(uuid.uuid4()),
                "issue_date": request["issue_date"],
                "state": "queued",
                "packet_ids": request["packet_ids"],
                "delivery_state": "not_requested",
                "created_at": at,
                "updated_at": at,
                "is_fixture": self.mode == "mock",
            }
            self.db.execute(
                "INSERT INTO editions VALUES (?,?,?,?,?,?)",
                (
                    edition["id"],
                    request["request_key"],
                    digest,
                    "queued",
                    contracts.canonical_json(edition),
                    contracts.canonical_json(packets),
                ),
            )
            if workflow_binding is not None:
                self.db.execute(
                    "INSERT INTO workflow_editions "
                    "(edition_id,run_id,editor_result,required_packets,proj"
                    "ection_required) "
                    "VALUES(?,?,?,?,?)",
                    (
                        edition["id"],
                        workflow_binding["run_id"],
                        contracts.canonical_json(workflow_binding["result"]),
                        contracts.canonical_json(
                            sorted(set(workflow_binding["required_packets"]))
                        ),
                        int(workflow_binding.get("projection_required", True)),
                    ),
                )
            return edition

    def get(self, edition_id: str) -> types.EditionRecord:
        """Return a saved edition or raise StoreError when its ID is absent."""
        with self.lock:
            row = self.db.execute(
                "SELECT body FROM editions WHERE id=?", (edition_id,)
            ).fetchone()
            if not row:
                raise StoreError("not_found", "Edition not found")
            # Only this store writes edition records, after boundary validation.
            return cast(types.EditionRecord, json.loads(row[0]))

    def _write(self, edition: types.EditionRecord) -> None:
        edition["updated_at"] = now()
        self.db.execute(
            "UPDATE editions SET state=?,body=? WHERE id=?",
            (
                edition["state"],
                contracts.canonical_json(edition),
                edition["id"],
            ),
        )

    def claim(self) -> tuple[types.EditionRecord, list[types.Payload]] | None:
        """Claim the next queued edition with its frozen input packet list."""
        with self.transaction():
            row = self.db.execute(
                "SELECT body,snapshot FROM editions WHERE state='queued' "
                "ORDER BY rowid LIMIT 1"
            ).fetchone()
            if not row:
                return None
            edition = cast(types.EditionRecord, json.loads(row["body"]))
            edition["state"] = "running"
            self._write(edition)
            return edition, json.loads(row["snapshot"])

    def finish(
        self, edition_id: str, **fields: Unpack[types.EditionPatch]
    ) -> types.EditionRecord:
        """Atomically apply worker result fields to an existing edition."""
        with self.transaction():
            edition = self.get(edition_id)
            edition.update(fields)
            self._write(edition)
            return edition

    def recover(self) -> None:
        """Recover interrupted work without resubmitting ambiguous mail."""
        with self.transaction():
            for row in self.db.execute(
                "SELECT body,snapshot FROM editions"
            ).fetchall():
                edition = cast(types.EditionRecord, json.loads(row["body"]))
                changed = False
                if edition["state"] == "running":
                    if self._recoverable_local_render(edition, row["snapshot"]):
                        edition.update({"state": "queued", "error_code": ""})
                    else:
                        edition.update(
                            {"state": "failed", "error_code": "interrupted"}
                        )
                    changed = True
                if edition["delivery_state"] == "submitting":
                    edition.update(
                        {
                            "delivery_state": "unknown",
                            "error_code": "delivery_unknown",
                        }
                    )
                    changed = True
                if changed:
                    self._write(edition)
            self.db.execute(
                "UPDATE packets SET projection='unknown' WHERE "
                "projection='submitting'"
            )

    def interrupt_preparation(self, edition_id: str) -> None:
        """Apply the narrow local-only recovery policy on cancellation.

        Never retry an editor call, an arbitrary failed edition, a frozen render
        or a delivery attempt. Only assembling an already approved publication
        may be requeued without another model decision.
        """
        with self.transaction():
            row = self.db.execute(
                "SELECT body,snapshot FROM editions WHERE id=?", (edition_id,)
            ).fetchone()
            if row is None:
                return
            edition = cast(types.EditionRecord, json.loads(row["body"]))
            if edition["state"] != "running":
                return
            if self._recoverable_local_render(edition, row["snapshot"]):
                edition.update({"state": "queued", "error_code": ""})
            else:
                edition.update({"state": "failed", "error_code": "interrupted"})
            self._write(edition)

    def _recoverable_local_render(
        self, edition: types.EditionRecord, snapshot_json: str
    ) -> bool:
        """Check for drift inside the caller's transaction without writing."""
        if (
            edition["delivery_state"] != "not_requested"
            or "rendered" in edition
            or self.db.execute(
                "SELECT 1 FROM sends WHERE edition_id=? OR issue_date=?",
                (edition["id"], edition["issue_date"]),
            ).fetchone()
        ):
            return False
        binding = self.db.execute(
            "SELECT run_id,editor_result,required_packets FROM "
            "workflow_editions "
            "WHERE edition_id=? AND projection_required=0",
            (edition["id"],),
        ).fetchone()
        if (
            binding is None
            or self.db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND "
                "name='publication_snapshots'"
            ).fetchone()
            is None
        ):
            return False
        publication = self.db.execute(
            "SELECT issue_date,tasks,body,digest FROM "
            "publication_snapshots WHERE run_id=?",
            (binding["run_id"],),
        ).fetchone()
        if (
            publication is None
            or publication["issue_date"] != edition["issue_date"]
        ):
            return False
        try:
            frozen = json.loads(publication["body"])
            packets = frozen["packets"]
            expected = {"draft": frozen["draft"], "review": frozen["review"]}
            if (
                frozen["notion_required"] is not False
                or frozen["review"]["passed"] is not True
                or contracts.canonical_json(expected)
                != binding["editor_result"]
                or contracts.canonical_json(packets)
                != contracts.canonical_json(json.loads(snapshot_json))
                or [packet["id"] for packet in packets] != edition["packet_ids"]
                or publication["digest"]
                != contracts.content_hash(
                    {
                        "issue_date": edition["issue_date"],
                        "tasks": json.loads(publication["tasks"]),
                        "result": frozen,
                    }
                )
            ):
                return False
            by_id = {packet["id"]: packet for packet in packets}
            required = json.loads(binding["required_packets"])
            if not required or any(key not in by_id for key in required):
                return False
            for key in required:
                saved = self.db.execute(
                    "SELECT body FROM packets WHERE id=?", (key,)
                ).fetchone()
                if (
                    saved is None
                    or contracts.canonical_json(json.loads(saved["body"]))
                    != contracts.canonical_json(by_id[key])
                    or by_id[key]["content_hash"]
                    != contracts.content_hash(by_id[key]["content"])
                ):
                    return False
            contracts.validate_draft(
                frozen["draft"], [by_id[key] for key in required]
            )
            return True
        except (KeyError, TypeError, ValueError):
            return False

    def reserve_send(
        self, request: types.Payload
    ) -> tuple[types.EditionRecord, bool]:
        """Reserve one publication per date, preserving ambiguous prior sends.

        Returns the durable edition and whether this call created a dispatch
        reservation. An existing identical request is a receipt, not a retry.
        """
        with self.transaction():
            edition = self.get(request["id"])
            if edition["state"] != "ready":
                raise StoreError("conflict", "Only a ready edition can be sent")
            if (
                edition["rendered"]["render_hash"]
                != request["expected_render_hash"]
            ):
                raise StoreError(
                    "conflict", "Approval does not match the frozen preview"
                )
            row = self.db.execute(
                "SELECT * FROM sends WHERE request_key=?",
                (request["request_key"],),
            ).fetchone()
            if row and (
                row["edition_id"] != request["id"]
                or row["render_hash"] != request["expected_render_hash"]
            ):
                raise StoreError(
                    "conflict",
                    "Send request_key was used for a different approval",
                )
            row = self.db.execute(
                "SELECT * FROM sends WHERE issue_date=?",
                (edition["issue_date"],),
            ).fetchone()
            if row:
                if row["edition_id"] != edition["id"]:
                    raise StoreError(
                        "conflict", "This issue already has a delivery attempt"
                    )
                return edition, False
            self.assert_workflow_research(edition["id"])
            self.db.execute(
                "INSERT INTO sends VALUES(?,?,?,?)",
                (
                    edition["issue_date"],
                    edition["id"],
                    request["request_key"],
                    request["expected_render_hash"],
                ),
            )
            edition["delivery_state"] = "submitting"
            self._write(edition)
            return edition, True

    def reserve_verification_send(
        self,
        request: types.Payload,
        *,
        previous_verification_id: str | None = None,
    ) -> tuple[types.EditionRecord, bool]:
        """Reserve an explicit verification, separate from daily delivery.

        Default: one extra attempt per date. A further manual approval must name
        the last accepted verification; it can have only one successor. Never
        called by cron. Unknown outcomes cannot be bypassed with a new approval,
        and an existing frozen receipt is idempotent even after later children.
        """
        with self.transaction():
            edition = self.get(request["id"])
            if edition["state"] != "ready":
                raise StoreError(
                    "conflict", "Only a ready edition can be verified"
                )
            if (
                edition["rendered"]["render_hash"]
                != request["expected_render_hash"]
            ):
                raise StoreError(
                    "conflict", "Approval does not match the frozen preview"
                )
            reused = self.db.execute(
                "SELECT edition_id,render_hash FROM verification_sends "
                "WHERE request_key=?",
                (request["request_key"],),
            ).fetchone()
            if reused and tuple(reused) != (
                request["id"],
                request["expected_render_hash"],
            ):
                raise StoreError(
                    "conflict", "Verification key belongs to another approval"
                )
            existing = self.db.execute(
                "SELECT render_hash,previous_edition_id FROM "
                "verification_sends WHERE edition_id=?",
                (edition["id"],),
            ).fetchone()
            if existing:
                if existing["render_hash"] != request[
                    "expected_render_hash"
                ] or (
                    previous_verification_id is not None
                    and existing["previous_edition_id"]
                    != previous_verification_id
                ):
                    raise StoreError(
                        "conflict",
                        "Verification receipt belongs to another approval",
                    )
                return edition, False
            previous = self.db.execute(
                "SELECT edition_id FROM sends WHERE issue_date=?",
                (edition["issue_date"],),
            ).fetchone()
            if previous is None or previous[0] == edition["id"]:
                raise StoreError(
                    "conflict",
                    "Verification requires a distinct delivered issue",
                )
            accepted = (
                "simulated" if self.mode == "mock" else "provider_accepted"
            )
            if self.get(previous[0])["delivery_state"] != accepted:
                raise StoreError(
                    "conflict",
                    "Original delivery must have confirmed acceptance",
                )
            rows = self.db.execute(
                "SELECT edition_id,render_hash,previous_edition_id FROM "
                "verification_sends "
                "WHERE issue_date=?",
                (edition["issue_date"],),
            ).fetchall()
            predecessor = previous[0]
            if previous_verification_id is None:
                if rows:
                    raise StoreError(
                        "conflict",
                        "This date already has a verification attempt",
                    )
            else:
                predecessor = self._verification_extension(
                    rows,
                    previous[0],
                    previous_verification_id,
                    edition["issue_date"],
                    accepted,
                )
            if edition["delivery_state"] != "not_requested":
                raise StoreError(
                    "conflict", "Edition already has a delivery attempt"
                )
            self.assert_workflow_research(edition["id"])
            self.db.execute(
                "INSERT INTO verification_sends "
                "(issue_date,edition_id,request_key,render_hash,previous_ed"
                "ition_id,created_at) "
                "VALUES(?,?,?,?,?,?)",
                (
                    edition["issue_date"],
                    edition["id"],
                    request["request_key"],
                    request["expected_render_hash"],
                    predecessor,
                    now(),
                ),
            )
            edition["delivery_state"] = "submitting"
            self._write(edition)
            return edition, True

    def _verification_extension(
        self,
        rows: list[sqlite3.Row],
        original_id: str,
        approved_predecessor: str,
        issue_date: str,
        accepted_state: str,
    ) -> str:
        """Require an intact, fully accepted chain ending at this approval."""
        successors = {row["previous_edition_id"]: row for row in rows}
        cursor = original_id
        visited: set[str] = set()
        while cursor in successors:
            row = successors[cursor]
            if row["edition_id"] in visited:
                raise StoreError(
                    "conflict", "Verification receipt chain is inconsistent"
                )
            prior = self.get(row["edition_id"])
            if (
                prior["issue_date"] != issue_date
                or prior["delivery_state"] != accepted_state
                or prior["rendered"]["render_hash"] != row["render_hash"]
            ):
                raise StoreError(
                    "conflict",
                    "Prior verification must have confirmed frozen acceptance",
                )
            visited.add(row["edition_id"])
            cursor = row["edition_id"]
        if (
            not rows
            or len(visited) != len(rows)
            or cursor != approved_predecessor
        ):
            raise StoreError(
                "conflict",
                "Approval must name the latest same-date verification",
            )
        return cursor

    def assert_workflow_research(self, edition_id: str) -> None:
        """Enforce the frozen edition's policy, never the latest global setting.

        Legacy editions retain their original Notion gate. Story publications
        need an intact local evidence snapshot instead; a delayed summary copy
        in Notion cannot invalidate independently checked local research.
        """
        with self.lock:
            binding = self.db.execute(
                "SELECT required_packets,projection_required FROM "
                "workflow_editions "
                "WHERE edition_id=?",
                (edition_id,),
            ).fetchone()
            if binding is None:
                return
            required = json.loads(binding["required_packets"])
            rows = {
                packet_id: self.db.execute(
                    "SELECT body,projection FROM packets WHERE id=?",
                    (packet_id,),
                ).fetchone()
                for packet_id in required
            }
            if binding["projection_required"]:
                if not required or any(
                    row is None or row["projection"] != "done"
                    for row in rows.values()
                ):
                    raise StoreError(
                        "conflict",
                        "Adopted research must be confirmed in Notion "
                        "before sending",
                    )
                return
            frozen = self.db.execute(
                "SELECT snapshot FROM editions WHERE id=?", (edition_id,)
            ).fetchone()
            snapshot = json.loads(frozen["snapshot"]) if frozen else []
            packets = {packet["id"]: packet for packet in snapshot}
            if not required or any(
                row is None
                or packet_id not in packets
                or contracts.canonical_json(json.loads(row["body"]))
                != contracts.canonical_json(packets[packet_id])
                or packets[packet_id]["content_hash"]
                != contracts.content_hash(packets[packet_id]["content"])
                for packet_id, row in rows.items()
            ):
                raise StoreError(
                    "conflict",
                    "Publication requires intact frozen local research",
                )
            try:
                contracts.validate_draft(
                    self.get(edition_id)["draft"],
                    [packets[key] for key in required],
                )
            except (KeyError, ValueError):
                raise StoreError(
                    "conflict",
                    "Publication references do not match frozen research",
                ) from None

    def claim_projection(self) -> types.Payload | None:
        """Claim one pending packet for a single external projection attempt."""
        with self.transaction():
            row = self.db.execute(
                "SELECT id,body FROM packets WHERE projection='pending' "
                "ORDER BY seq LIMIT 1"
            ).fetchone()
            if not row:
                return None
            self.db.execute(
                "UPDATE packets SET projection='submitting' WHERE id=?",
                (row["id"],),
            )
            return cast(types.Payload, json.loads(row["body"]))

    def projection_result(
        self, packet_id: str, state: types.ProjectionState
    ) -> None:
        """Persist the known or explicitly unknown projection outcome."""
        with self.transaction():
            self.db.execute(
                "UPDATE packets SET projection=? WHERE id=?", (state, packet_id)
            )

    def recent_history(self) -> list[types.EditionRecord]:
        """Filter the newest 60 editions to accepted or unknown deliveries."""
        with self.lock:
            rows = self.db.execute(
                "SELECT body FROM editions ORDER BY rowid DESC LIMIT 60"
            ).fetchall()
        return [
            e
            for row in rows
            if (e := cast(types.EditionRecord, json.loads(row[0])))[
                "delivery_state"
            ]
            in {"provider_accepted", "unknown"}
        ][:7]
