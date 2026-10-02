"""Durable Notion receipts, separate from publication and email receipts.

SQLite owns identities and immutable body versions. A timed-out create/append is
reconciled by reading Notion; it is never blindly repeated. No network call is
made inside a transaction, and this module cannot enqueue research or send mail.
"""

from __future__ import annotations

import base64
from collections.abc import Sequence
import json
import time
from typing import Any
import urllib.parse as parse

import newsletter.contracts as contracts
import newsletter.notion_content as notion_content
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.workflow.sources as sources


def material_aliases(candidate: types.Payload) -> list[str]:
    """Resolve identities; generic landing pages need a dated event key."""
    keys = sources.identity_keys(candidate)
    keys = {key for key in keys if not key.startswith("title:")}
    strong = {key for key in keys if key.startswith(("doi:", "arxiv:"))}
    if strong:
        # A broad topic such as "new architecture" does not identify a paper.
        keys = {key for key in keys if not key.startswith("event:")}
    if not strong:
        for key in list(keys):
            if key.startswith("url:") and parse.urlsplit(key[4:]).path.rstrip(
                "/"
            ) in {
                "",
                "/news",
                "/research",
                "/publications",
                "/papers",
                "/blog",
            }:
                keys.remove(key)
                event = str(
                    candidate.get("event_key")
                    or candidate.get("published_at")
                    or ""
                )
                if event:
                    keys.add(key + "#event:" + event.casefold())
    if not keys:
        raise ValueError("notion_material_identity_missing")
    return sorted(
        keys,
        key=lambda key: (
            next(
                i
                for i, prefix in enumerate(("doi:", "arxiv:", "url:", "event:"))
                if key.startswith(prefix)
            ),
            key,
        ),
    )


class NotionJournal:
    """Own the local Notion projection state and its import read models."""

    def __init__(
        self, store: newsletter_store.Store, destination: types.Payload
    ) -> None:
        self.store = store
        with store.lock:
            store.db.executescript("""
                CREATE TABLE IF NOT EXISTS notion_entities (
                    key TEXT PRIMARY KEY, kind TEXT NOT NULL,
                    page_id TEXT NOT NULL DEFAULT '',
                    create_state TEXT NOT NULL DEFAULT 'new',
                    properties TEXT NOT NULL,
                    applied_hash TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    retry_at REAL NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS notion_versions (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity_key TEXT NOT NULL, digest TEXT NOT NULL,
                    blocks TEXT NOT NULL, chart TEXT NOT NULL,
                    upload_id TEXT NOT NULL DEFAULT '',
                    upload_at REAL NOT NULL DEFAULT 0,
                    state TEXT NOT NULL DEFAULT 'pending',
                    offset INTEGER NOT NULL DEFAULT 0,
                    pending_chunk TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '', UNIQUE(entity_key,digest),
                    FOREIGN KEY(entity_key) REFERENCES notion_entities(key));
                CREATE TABLE IF NOT EXISTS notion_aliases (
                    alias TEXT PRIMARY KEY, entity_key TEXT NOT NULL,
                    FOREIGN KEY(entity_key) REFERENCES notion_entities(key));
                CREATE TABLE IF NOT EXISTS notion_candidates (
                    run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    body TEXT NOT NULL, first_seen TEXT NOT NULL,
                    PRIMARY KEY(run_id,candidate_id));
                CREATE TABLE IF NOT EXISTS notion_imports (
                    kind TEXT NOT NULL, source_id TEXT NOT NULL,
                    digest TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY(kind,source_id));
                CREATE TABLE IF NOT EXISTS notion_links (
                    edition_key TEXT NOT NULL, material_key TEXT NOT NULL,
                    PRIMARY KEY(edition_key,material_key));
            """)
        with store.transaction():
            if "upload_at" not in {
                row["name"]
                for row in store.db.execute(
                    "PRAGMA table_info(notion_versions)"
                )
            }:
                store.db.execute(
                    "ALTER TABLE notion_versions ADD COLUMN upload_at "
                    "REAL NOT NULL DEFAULT 0"
                )
            digest = contracts.content_hash(destination)
            old = store.db.execute(
                "SELECT value FROM metadata WHERE key='notion_v2_destination'"
            ).fetchone()
            if old and old[0] != digest:
                raise ValueError(
                    "Notion destination/privacy changed; "
                    "explicit migration required"
                )
            store.db.execute(
                "INSERT OR IGNORE INTO metadata "
                "VALUES ('notion_v2_destination',?)",
                (digest,),
            )
            # A crash after dispatch but before acknowledgement is an unknown
            # external result, not permission to repeat the mutation.
            store.db.execute(
                "UPDATE notion_entities SET create_state='unknown' "
                "WHERE create_state='creating'"
            )
            store.db.execute(
                "UPDATE notion_versions SET state='unknown' "
                "WHERE state='appending'"
            )

    def rows(self, sql: str, args: tuple[Any, ...] = ()) -> list[types.Payload]:
        """Read journal rows under the shared database lock."""
        with self.store.lock:
            return [
                dict(row) for row in self.store.db.execute(sql, args).fetchall()
            ]

    def execute(self, sql: str, args: tuple[Any, ...] = ()) -> None:
        """Execute a local journal statement in a complete transaction."""
        with self.store.transaction():
            self.store.db.execute(sql, args)

    def exists(self, table: str) -> bool:
        """Check for optional historical tables without creating them."""
        return bool(
            self.rows(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            )
        )

    def bootstrap_time(self) -> str:
        """Return the durable boundary between historical and live imports."""
        self.execute(
            "INSERT OR IGNORE INTO metadata VALUES('notion_v2_bootstrap_at',?)",
            (newsletter_store.now(),),
        )
        return str(
            self.rows(
                "SELECT value FROM metadata WHERE key='notion_v2_bootstrap_at'"
            )[0]["value"]
        )

    def pending_candidates(self) -> list[types.Payload]:
        """Read a bounded batch of unacknowledged frozen candidate artifacts."""
        if not self.exists("workflow_artifacts"):
            return []
        return self.rows(
            "SELECT a.*,r.definition FROM workflow_artifacts a "
            "JOIN workflow_runs r ON r.id=a.run_id WHERE a.item_id='' "
            "AND NOT EXISTS(SELECT 1 FROM notion_imports i "
            "WHERE i.kind='candidates' AND i.source_id=a.id) "
            "ORDER BY a.rowid LIMIT 40"
        )

    def candidate(self, run_id: str, candidate_id: str) -> types.Payload | None:
        """Read a candidate's immutable snapshot within one run."""
        rows = self.rows(
            "SELECT * FROM notion_candidates WHERE run_id=? AND candidate_id=?",
            (run_id, candidate_id),
        )
        return rows[0] if rows else None

    def candidates(self, run_id: str) -> list[types.Payload]:
        """Read the material identities and snapshots belonging to one run."""
        return self.rows(
            "SELECT body,entity_key FROM notion_candidates WHERE run_id=?",
            (run_id,),
        )

    def first_seen(self, key: str, fallback: str) -> str:
        """Return the earliest archived timestamp for a material identity."""
        rows = self.rows(
            "SELECT MIN(first_seen) AS first_seen FROM notion_candidates "
            "WHERE entity_key=?",
            (key,),
        )
        return str(rows[0]["first_seen"] or fallback)

    def remember_candidate(
        self, run_id: str, candidate_id: str, key: str, body: str, first: str
    ) -> None:
        """Acknowledge a candidate after its idempotent projection enqueue."""
        self.execute(
            "INSERT OR IGNORE INTO notion_candidates VALUES(?,?,?,?,?)",
            (run_id, candidate_id, key, body, first),
        )

    def pending_research(self) -> list[types.Payload]:
        """Read complete research for candidates already in the journal."""
        if not self.exists("publication_units"):
            return []
        return self.rows(
            "SELECT u.* FROM publication_units u "
            "WHERE NOT EXISTS(SELECT 1 FROM notion_imports i "
            "WHERE i.kind='research' AND i.source_id=u.digest) "
            "AND EXISTS(SELECT 1 FROM notion_candidates c "
            "WHERE c.run_id=u.run_id) ORDER BY u.rowid LIMIT 20"
        )

    def editions_for_links(self) -> list[types.Payload]:
        """Read archived editions whose material relations may need repair."""
        return self.rows(
            "SELECT e.body,e.snapshot,w.run_id,n.key FROM editions e "
            "JOIN workflow_editions w ON w.edition_id=e.id "
            "JOIN notion_entities n ON n.key='edition:'||e.id "
            "WHERE e.state='ready'"
        )

    def pending_editions(self) -> list[types.Payload]:
        """Read ready editions with new or not-yet-imported update receipts."""
        return self.rows(
            "SELECT e.*,w.run_id FROM editions e "
            "LEFT JOIN workflow_editions w ON w.edition_id=e.id "
            "WHERE e.state='ready' AND NOT EXISTS("
            "SELECT 1 FROM notion_imports i WHERE i.kind='edition' "
            "AND i.source_id=e.id AND i.digest="
            "CASE WHEN json_valid(e.body) THEN "
            "CASE WHEN json_type(e.body,'$.updated_at')='text' "
            "THEN json_extract(e.body,'$.updated_at') ELSE 'invalid' END "
            "ELSE 'invalid' END) ORDER BY e.rowid LIMIT 20"
        )

    def is_verification(self, edition_id: str) -> bool:
        """Report whether an edition has an explicit verification receipt."""
        return bool(
            self.rows(
                "SELECT 1 FROM verification_sends WHERE edition_id=?",
                (edition_id,),
            )
        )

    def is_daily_run(self, run_id: str, issue_date: str) -> bool:
        """Classify a run, preserving the pre-collection legacy behavior."""
        if not self.exists("collection_runs"):
            return True
        rows = self.rows(
            "SELECT request_key FROM collection_runs WHERE id=?", (run_id,)
        )
        return bool(rows and rows[0]["request_key"] == "daily-" + issue_date)

    def link(self, edition_key: str, material_key: str) -> None:
        """Record an actually cited material relation idempotently."""
        self.execute(
            "INSERT OR IGNORE INTO notion_links VALUES(?,?)",
            (edition_key, material_key),
        )

    def due_entities(self, at: float) -> list[types.Payload]:
        """Read entities whose projection backoff has elapsed."""
        return self.rows(
            "SELECT * FROM notion_entities WHERE retry_at<=? ORDER BY rowid",
            (at,),
        )

    def begin_create(self, key: str) -> None:
        """Persist dispatch intent before making the external create call."""
        self.execute(
            "UPDATE notion_entities SET create_state='creating' WHERE key=?",
            (key,),
        )

    def fail_create(self, key: str, *, ambiguous: bool) -> None:
        """Record whether a failed create is safe to attempt again."""
        self.execute(
            "UPDATE notion_entities SET create_state=? WHERE key=?",
            ("unknown" if ambiguous else "new", key),
        )

    def confirm_page(
        self, key: str, page_id: str, applied_hash: str | None = None
    ) -> None:
        """Bind a known remote page without inventing property acceptance."""
        self.execute(
            "UPDATE notion_entities SET page_id=?,create_state='ready',"
            "applied_hash=COALESCE(?,applied_hash) WHERE key=?",
            (page_id, applied_hash, key),
        )

    def resolve_conflict(self, key: str) -> None:
        """Clear a conflict only after the caller verifies the remote body."""
        self.execute(
            "UPDATE notion_entities SET create_state='ready' WHERE key=?",
            (key,),
        )

    def quarantine(self, key: str) -> None:
        """Keep conflicting material out of automatic mutation paths."""
        self.execute(
            "UPDATE notion_entities SET create_state='conflict' WHERE key=?",
            (key,),
        )

    def record_upload(self, sequence: int, upload_id: str, at: float) -> None:
        """Remember a temporary chart upload before attempting its append."""
        self.execute(
            "UPDATE notion_versions SET upload_id=?,upload_at=? WHERE seq=?",
            (upload_id, at, sequence),
        )

    def finish_version(self, sequence: int) -> None:
        """Mark a fully acknowledged body version complete."""
        self.execute(
            "UPDATE notion_versions SET state='done' WHERE seq=?", (sequence,)
        )

    def begin_append(self, sequence: int, chunk: list[types.Payload]) -> None:
        """Persist the exact append receipt before any remote write."""
        self.execute(
            "UPDATE notion_versions SET state='appending',pending_chunk=? "
            "WHERE seq=?",
            (contracts.canonical_json(chunk), sequence),
        )

    def fail_append(self, sequence: int, *, ambiguous: bool) -> None:
        """Retain an uncertain append receipt until readback resolves it."""
        self.execute(
            "UPDATE notion_versions SET state=? WHERE seq=?",
            ("unknown" if ambiguous else "pending", sequence),
        )

    def acknowledge_append(
        self, sequence: int, offset: int, *, complete: bool
    ) -> None:
        """Advance only a remotely acknowledged or readback-confirmed prefix."""
        self.execute(
            "UPDATE notion_versions SET offset=?,state=?,pending_chunk='',"
            "error='' WHERE seq=?",
            (offset, "done" if complete else "pending", sequence),
        )

    def acknowledge_properties(self, key: str, digest: str) -> None:
        """Remember a successful idempotent remote property assignment."""
        self.execute(
            "UPDATE notion_entities SET applied_hash=? WHERE key=?",
            (digest, key),
        )

    def identity(self, candidate: types.Payload) -> tuple[str, list[str]]:
        """Resolve compatible aliases without silently merging conflicts."""
        aliases = material_aliases(candidate)
        found = {
            row["entity_key"]
            for row in self.rows(
                "SELECT entity_key FROM notion_aliases WHERE alias IN ("
                + ",".join("?" for _ in aliases)
                + ")",
                tuple(aliases),
            )
        }
        if len(found) > 1:
            raise ValueError("notion_material_identity_conflict")
        if found:
            existing_aliases = {
                row["alias"]
                for row in self.rows(
                    "SELECT alias FROM notion_aliases WHERE entity_key=?",
                    (next(iter(found)),),
                )
            }
            for prefix in ("doi:", "arxiv:"):
                incoming = {key for key in aliases if key.startswith(prefix)}
                previous = {
                    key for key in existing_aliases if key.startswith(prefix)
                }
                if incoming and previous and incoming.isdisjoint(previous):
                    raise ValueError("notion_material_identity_conflict")
        return (
            next(iter(found))
            if found
            else "material:v1:" + contracts.content_hash(aliases[0]),
            aliases,
        )

    def enqueue(
        self,
        kind: str,
        projection: notion_content.Projection,
        aliases: Sequence[str] = (),
    ) -> None:
        """Atomically bind aliases and enqueue an immutable body version."""
        with self.store.transaction():
            old = self.store.db.execute(
                "SELECT kind,properties FROM notion_entities WHERE key=?",
                (projection.key,),
            ).fetchone()
            if old and old[0] != kind:
                raise ValueError("notion_entity_kind_conflict")
            if (
                kind == "edition"
                and self.store.db.execute(
                    "SELECT 1 FROM notion_versions "
                    "WHERE entity_key=? AND digest!=?",
                    (projection.key, projection.digest),
                ).fetchone()
            ):
                # Updating delivery columns must never mutate a frozen edition.
                raise ValueError("notion_frozen_edition_changed")
            properties = json.loads(
                contracts.canonical_json(projection.properties)
            )
            if old and kind == "material":
                previous = json.loads(old["properties"])
                for name in ("direction", "topics"):
                    names = {
                        item["name"]
                        for source in (previous, properties)
                        for item in source.get(name, {}).get("multi_select", [])
                    }
                    properties[name] = {
                        "multi_select": [
                            {"name": name} for name in sorted(names)
                        ]
                    }
                ranks = ["候选", "继续跟进", "已研究", "已刊出"]
                progress = [
                    source.get("progress", {})
                    .get("select", {})
                    .get("name", "候选")
                    for source in (previous, properties)
                ]
                properties["progress"] = {
                    "select": {"name": max(progress, key=ranks.index)}
                }
                properties["fixture"] = {
                    "checkbox": all(
                        source.get("fixture", {}).get("checkbox", False)
                        for source in (previous, properties)
                    )
                }
                for name in (
                    "authors",
                    "affiliations",
                    "venue",
                    "publication_status",
                ):
                    if (
                        not properties.get(name, {}).get("rich_text")
                        and name in previous
                    ):
                        properties[name] = previous[name]
            self.store.db.execute(
                "INSERT INTO notion_entities(key,kind,properties) "
                "VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET properties=excluded.properties",
                (projection.key, kind, contracts.canonical_json(properties)),
            )
            self.store.db.execute(
                "INSERT OR IGNORE INTO notion_versions"
                "(entity_key,digest,blocks,chart) "
                "VALUES(?,?,?,?)",
                (
                    projection.key,
                    projection.digest,
                    contracts.canonical_json(projection.blocks),
                    base64.b64encode(projection.chart_png or b"").decode(),
                ),
            )
            for alias in aliases:
                old_alias = self.store.db.execute(
                    "SELECT entity_key FROM notion_aliases WHERE alias=?",
                    (alias,),
                ).fetchone()
                if old_alias and old_alias[0] != projection.key:
                    raise ValueError("notion_material_identity_conflict")
                self.store.db.execute(
                    "INSERT OR IGNORE INTO notion_aliases VALUES (?,?)",
                    (alias, projection.key),
                )

    def imported(self, kind: str, source_id: str, digest: str) -> bool:
        """Report whether this exact source version has an import receipt."""
        return bool(
            self.rows(
                "SELECT 1 FROM notion_imports "
                "WHERE kind=? AND source_id=? AND digest=?",
                (kind, source_id, digest),
            )
        )

    def mark_import(
        self, kind: str, source_id: str, digest: str, error: str = ""
    ) -> None:
        """Record either a successful import or its safe diagnostic code."""
        self.execute(
            "INSERT INTO notion_imports VALUES(?,?,?,?) "
            "ON CONFLICT(kind,source_id) "
            "DO UPDATE SET digest=excluded.digest,error=excluded.error",
            (kind, source_id, digest, error),
        )

    def entity(self, key: str) -> types.Payload:
        """Read one existing material or edition projection identity."""
        return self.rows("SELECT * FROM notion_entities WHERE key=?", (key,))[0]

    def versions(self, key: str) -> list[types.Payload]:
        """Read immutable body versions in their append order."""
        return self.rows(
            "SELECT * FROM notion_versions WHERE entity_key=? ORDER BY seq",
            (key,),
        )

    def desired(self, entity: types.Payload) -> types.Payload:
        """Build managed properties and resolved page relations."""
        properties = json.loads(entity["properties"])
        if not isinstance(properties, dict):
            raise ValueError("notion_properties_invalid")
        edition = entity["kind"] == "edition"
        source, target = (
            ("edition_key", "material_key")
            if edition
            else ("material_key", "edition_key")
        )
        related = self.rows(
            "SELECT DISTINCT e.page_id FROM notion_links l "
            f"JOIN notion_entities e ON e.key=l.{target} "
            f"WHERE l.{source}=? AND e.page_id!='' ORDER BY e.page_id",
            (entity["key"],),
        )
        if len(related) > 100:
            raise ValueError("notion_relation_capacity")
        properties["material_ids" if edition else "edition_ids"] = {
            "relation": [{"id": row["page_id"]} for row in related]
        }
        if not edition and related:
            properties["progress"] = {"select": {"name": "已刊出"}}
        done = all(v["state"] == "done" for v in self.versions(entity["key"]))
        properties["sync_state"] = {
            "select": {"name": "已同步" if done else "同步中"}
        }
        return properties

    def retry(self, key: str, code: str) -> None:
        """Defer another reconciliation pass with bounded backoff."""
        entity = self.entity(key)
        attempts = entity["attempts"] + 1
        delay = min(3600, 30 * 2 ** min(attempts - 1, 7))
        self.execute(
            "UPDATE notion_entities SET error=?,retry_at=?,attempts=? "
            "WHERE key=?",
            (code, time.time() + delay, attempts, key),
        )

    def clear_error(self, key: str) -> None:
        """Clear backoff after an entity makes confirmed progress."""
        self.execute(
            "UPDATE notion_entities SET error='',retry_at=0,attempts=0 "
            "WHERE key=?",
            (key,),
        )

    def summary(self) -> types.Payload:
        """Return counts and fixed error codes without source content."""
        return {
            "entities": self.rows(
                "SELECT kind,create_state,COUNT(*) AS count "
                "FROM notion_entities "
                "GROUP BY kind,create_state"
            ),
            "versions": self.rows(
                "SELECT state,COUNT(*) AS count FROM notion_versions "
                "GROUP BY state"
            ),
            "errors": self.rows(
                "SELECT error,COUNT(*) AS count FROM notion_entities "
                "WHERE error!='' GROUP BY error"
            ),
            "import_errors": self.rows(
                "SELECT error,COUNT(*) AS count FROM notion_imports "
                "WHERE error!='' GROUP BY error"
            ),
        }
