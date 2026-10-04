"""Persist immutable requests and restartable checkpoints before external effects."""

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ziyixi_proto.platform.runtime.v1.errors_pb import ErrorReason
from ziyixi_proto.rpc_status import RpcError


def error(code, reason, message):
    return RpcError(code, reason.name, message, domain="platform.ziyixi.science")


def now() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class Record:
    identity: str
    body: dict
    phase: str
    checkpoint: str
    revision: int
    created: str
    updated: str
    error_code: str
    observed: tuple
    gate_key: str = ""
    source_release: str = ""

    @property
    def etag(self) -> str:
        return hashlib.sha256(f"{self.identity}:{self.revision}".encode()).hexdigest()[
            :32
        ]


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        # Establish owner-only mode before SQLite creates its WAL/SHM companions.
        self.path.touch(mode=0o600, exist_ok=True)
        self.path.chmod(0o600)
        with self.transaction() as database:
            database.execute("""
                CREATE TABLE IF NOT EXISTS releases (
                    identity TEXT PRIMARY KEY,
                    body TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    checkpoint TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    created TEXT NOT NULL,
                    updated TEXT NOT NULL,
                    error_code TEXT NOT NULL,
                    observed TEXT NOT NULL
                )
            """)
            columns = {
                row[1] for row in database.execute("PRAGMA table_info(releases)")
            }
            for name in ("gate_key", "source_release"):
                if name not in columns:
                    database.execute(
                        f"ALTER TABLE releases ADD COLUMN {name} TEXT NOT NULL DEFAULT ''"
                    )
            database.execute(
                "CREATE TABLE IF NOT EXISTS create_receipts (request_id TEXT PRIMARY KEY, identity TEXT NOT NULL)"
            )
            database.execute("""
                CREATE TABLE IF NOT EXISTS resume_receipts (
                    request_id TEXT PRIMARY KEY,
                    identity TEXT NOT NULL,
                    etag TEXT NOT NULL
                )
            """)
            database.execute("""
                CREATE TABLE IF NOT EXISTS reconcile_receipts (
                    request_id TEXT PRIMARY KEY,
                    input TEXT NOT NULL,
                    identity TEXT NOT NULL
                )
            """)

    @contextmanager
    def transaction(self):
        database = sqlite3.connect(self.path, timeout=5)
        database.row_factory = sqlite3.Row
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("PRAGMA synchronous=FULL")
        database.execute("BEGIN IMMEDIATE")
        try:
            yield database
            database.commit()
        except BaseException:
            database.rollback()
            raise
        finally:
            database.close()

    def create(self, identity: str, body: dict) -> Record:
        frozen = json.dumps(body, sort_keys=True, separators=(",", ":"))
        with self.transaction() as database:
            previous = database.execute(
                "SELECT * FROM releases WHERE identity=?", (identity,)
            ).fetchone()
            if previous:
                if previous["body"] != frozen:
                    raise error(
                        "ALREADY_EXISTS",
                        ErrorReason.RELEASE_CONFLICT,
                        "The release identity already has different targets.",
                    )
                return self._record(previous)
            reused = database.execute(
                "SELECT identity FROM create_receipts WHERE request_id=?",
                (body["request_id"],),
            ).fetchone()
            if reused:
                raise error(
                    "ALREADY_EXISTS",
                    ErrorReason.RELEASE_CONFLICT,
                    "The creation identity already belongs to another release.",
                )
            outstanding = database.execute(
                "SELECT identity FROM releases WHERE phase != 'ready' LIMIT 1"
            ).fetchone()
            if outstanding:
                raise error(
                    "FAILED_PRECONDITION",
                    ErrorReason.RELEASE_HELD,
                    "Finish or explicitly resume the existing release first.",
                )
            database.execute(
                "INSERT INTO create_receipts VALUES (?,?)",
                (body["request_id"], identity),
            )
            at = now()
            database.execute(
                "INSERT INTO releases (identity,body,phase,checkpoint,revision,created,updated,error_code,observed) "
                "VALUES (?,?, 'accepted','suspend',1,?,?, '', '[]')",
                (identity, frozen, at, at),
            )
            return self._record(
                database.execute(
                    "SELECT * FROM releases WHERE identity=?", (identity,)
                ).fetchone()
            )

    def reconcile_receipt(self, request: dict) -> Record | None:
        frozen = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self.transaction() as database:
            receipt = database.execute(
                "SELECT * FROM reconcile_receipts WHERE request_id=?",
                (request["request_id"],),
            ).fetchone()
            if not receipt:
                return None
            if receipt["input"] != frozen:
                raise error(
                    "ALREADY_EXISTS",
                    ErrorReason.RECONCILE_CONFLICT,
                    "This reconciliation identity has different input.",
                )
            return self._record(
                database.execute(
                    "SELECT * FROM releases WHERE identity=?", (receipt["identity"],)
                ).fetchone()
            )

    def reconcile(self, request: dict, body: dict | None) -> Record:
        """CAS the current ready source and persist a separate operation before effects."""
        frozen_input = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self.transaction() as database:
            receipt = database.execute(
                "SELECT * FROM reconcile_receipts WHERE request_id=?",
                (request["request_id"],),
            ).fetchone()
            if receipt:
                if receipt["input"] != frozen_input:
                    raise error(
                        "ALREADY_EXISTS",
                        ErrorReason.RECONCILE_CONFLICT,
                        "This reconciliation identity has different input.",
                    )
                return self._record(
                    database.execute(
                        "SELECT * FROM releases WHERE identity=?",
                        (receipt["identity"],),
                    ).fetchone()
                )
            row = database.execute(
                "SELECT * FROM releases ORDER BY created DESC, rowid DESC LIMIT 1"
            ).fetchone()
            source = self._record(row) if row else None
            if (
                source is None
                or "releases/" + source.identity != request["name"]
                or source.etag != request["etag"]
            ):
                raise error(
                    "ABORTED",
                    ErrorReason.RECONCILE_PLAN_CHANGED,
                    "Read the current release and plan before repairing.",
                )
            if (
                source.phase != "ready"
                or database.execute(
                    "SELECT identity FROM releases WHERE phase != 'ready' LIMIT 1"
                ).fetchone()
            ):
                raise error(
                    "FAILED_PRECONDITION",
                    ErrorReason.RELEASE_HELD,
                    "Finish the existing release before repairing.",
                )
            identity = request["request_id"] if body is not None else source.identity
            if body is not None:
                if (
                    database.execute(
                        "SELECT identity FROM releases WHERE identity=?", (identity,)
                    ).fetchone()
                    or database.execute(
                        "SELECT identity FROM create_receipts WHERE request_id=?",
                        (identity,),
                    ).fetchone()
                ):
                    raise error(
                        "ALREADY_EXISTS",
                        ErrorReason.RECONCILE_CONFLICT,
                        "This reconciliation identity already belongs to a release.",
                    )
                at = now()
                database.execute(
                    "INSERT INTO releases VALUES (?,?, 'accepted','suspend',1,?,?, '', '[]',?,?)",
                    (
                        identity,
                        json.dumps(body, sort_keys=True, separators=(",", ":")),
                        at,
                        at,
                        "release-" + identity,
                        request["name"],
                    ),
                )
                database.execute(
                    "INSERT INTO create_receipts VALUES (?,?)", (identity, identity)
                )
            database.execute(
                "INSERT INTO reconcile_receipts VALUES (?,?,?)",
                (request["request_id"], frozen_input, identity),
            )
            return self._record(
                database.execute(
                    "SELECT * FROM releases WHERE identity=?", (identity,)
                ).fetchone()
            )

    def get(self, identity: str) -> Record:
        with self.transaction() as database:
            row = database.execute(
                "SELECT * FROM releases WHERE identity=?", (identity,)
            ).fetchone()
        if row is None:
            raise error(
                "NOT_FOUND", ErrorReason.RELEASE_NOT_FOUND, "The release was not found."
            )
        return self._record(row)

    def latest(self) -> Record | None:
        with self.transaction() as database:
            row = database.execute(
                "SELECT * FROM releases ORDER BY created DESC, rowid DESC LIMIT 1"
            ).fetchone()
        return self._record(row) if row else None

    def active(self) -> Record | None:
        with self.transaction() as database:
            row = database.execute(
                "SELECT * FROM releases WHERE phase NOT IN ('ready','held','failed') ORDER BY rowid LIMIT 1"
            ).fetchone()
        return self._record(row) if row else None

    def checkpoint(
        self,
        identity: str,
        phase: str,
        checkpoint: str,
        *,
        error_code: str = "",
        observed: tuple = (),
    ) -> None:
        with self.transaction() as database:
            database.execute(
                "UPDATE releases SET phase=?, checkpoint=?, revision=revision+1, updated=?, error_code=?, observed=? WHERE identity=?",
                (phase, checkpoint, now(), error_code, json.dumps(observed), identity),
            )

    def resume(self, identity: str, etag: str, request_id: str) -> Record:
        with self.transaction() as database:
            receipt = database.execute(
                "SELECT * FROM resume_receipts WHERE request_id=?", (request_id,)
            ).fetchone()
            if receipt:
                if receipt["identity"] != identity or receipt["etag"] != etag:
                    raise error(
                        "ALREADY_EXISTS",
                        ErrorReason.RESUME_CONFLICT,
                        "The continuation identity already has a different request.",
                    )
                row = database.execute(
                    "SELECT * FROM releases WHERE identity=?", (identity,)
                ).fetchone()
                return self._record(row)
            row = database.execute(
                "SELECT * FROM releases WHERE identity=?", (identity,)
            ).fetchone()
            if row is None:
                raise error(
                    "NOT_FOUND",
                    ErrorReason.RELEASE_NOT_FOUND,
                    "The release was not found.",
                )
            record = self._record(row)
            if record.etag != etag:
                raise error(
                    "ABORTED",
                    ErrorReason.ETAG_MISMATCH,
                    "Read the current release before continuing it.",
                )
            if record.phase not in {"held", "failed"}:
                raise error(
                    "FAILED_PRECONDITION",
                    ErrorReason.RELEASE_NOT_HELD,
                    "Only an explicitly held release can be continued.",
                )
            database.execute(
                "UPDATE releases SET phase='accepted', revision=revision+1, updated=?, error_code='' WHERE identity=?",
                (now(), identity),
            )
            database.execute(
                "INSERT INTO resume_receipts VALUES (?,?,?)",
                (request_id, identity, etag),
            )
        return self.get(identity)

    @staticmethod
    def _record(row: sqlite3.Row) -> Record:
        return Record(
            row["identity"],
            json.loads(row["body"]),
            row["phase"],
            row["checkpoint"],
            row["revision"],
            row["created"],
            row["updated"],
            row["error_code"],
            tuple(json.loads(row["observed"])),
            row["gate_key"],
            row["source_release"],
        )
