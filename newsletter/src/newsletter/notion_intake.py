"""Project frozen DAG artifacts and editions, not mutable candidate history.

The importer is repeatable and bounded per pass. An invalid historical artifact
gets its own diagnostic receipt, without preventing other materials or editions
from being archived. These receipts are not editorial admission decisions.
"""

from __future__ import annotations

import datetime
import json
import logging

import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.notion_content as notion_content
import newsletter.notion_journal as notion_journal
import newsletter.types as types

logger = logging.getLogger(__name__)


def _object(value: object) -> types.Payload:
    if not isinstance(value, dict):
        raise ValueError("notion_import_object_required")
    return value


def _objects(raw: str) -> list[types.Payload]:
    value = json.loads(raw)
    if not isinstance(value, list):
        raise ValueError("notion_import_list_required")
    return [_object(item) for item in value]


def _failure(kind: str, reference: str, error: Exception) -> str:
    diagnostics.record_failure(
        logger,
        phase="notion_" + kind + "_import",
        error=error,
        reference=reference,
    )
    return "notion_" + kind + "_import_failed"


def citations(value: object) -> set[str]:
    """Collect explicit citation references from a frozen editorial value."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "citation" and isinstance(item, str):
                found.add(item)
            elif key in {"citations", "supporting_citations"} and isinstance(
                item, list
            ):
                found.update(text for text in item if isinstance(text, str))
            else:
                found.update(citations(item))
    elif isinstance(value, list):
        for item in value:
            found.update(citations(item))
    return found


class NotionIntake:
    """Import bounded batches using the journal's frozen read models."""

    def __init__(
        self, journal: notion_journal.NotionJournal, *, include_personal: bool
    ) -> None:
        self.journal = journal
        self.include_personal = include_personal
        self.bootstrap_at = journal.bootstrap_time()

    def historical(self, created_at: str) -> bool:
        """Report whether a receipt predates this installation's archive."""
        return datetime.datetime.fromisoformat(
            created_at
        ) < datetime.datetime.fromisoformat(self.bootstrap_at)

    def scan(self) -> int:
        """Import available frozen artifacts and repair cited relations."""
        imported = self._candidates() + self._research() + self._editions()
        self._repair_links()
        return imported

    def _candidates(self) -> int:
        j = self.journal
        rows = j.pending_candidates()
        for row in rows:
            error = ""
            try:
                definition = _object(json.loads(row["definition"]))
                node = next(
                    n for n in definition["nodes"] if n["id"] == row["node_id"]
                )
                if node["type"] == "deduplicate":
                    for candidate in _object(json.loads(row["body"]))[
                        "candidates"
                    ]:
                        try:
                            self._candidate(row, _object(candidate))
                        except (ValueError, KeyError, TypeError) as exc:
                            # One malformed lead must not discard its siblings.
                            error = _failure("candidate", row["id"], exc)
            except (ValueError, KeyError, TypeError, StopIteration) as exc:
                error = _failure("candidate", row["id"], exc)
            j.mark_import("candidates", row["id"], row["content_hash"], error)
        return len(rows)

    def _candidate(self, row: types.Payload, candidate: types.Payload) -> None:
        j = self.journal
        body = contracts.canonical_json(candidate)
        previous = j.candidate(row["run_id"], candidate["id"])
        if previous and previous["body"] != body:
            raise ValueError("notion_candidate_snapshot_changed")
        key, aliases = j.identity(candidate)
        first = j.first_seen(key, row["created_at"])
        projection = notion_content.material_projection(
            candidate,
            key=key,
            first_seen=datetime.datetime.fromisoformat(first)
            .date()
            .isoformat(),
            run_id=row["run_id"],
            fixture=self.historical(row["created_at"]),
        )
        j.enqueue("material", projection, aliases)
        # A crash here is recoverable: enqueue is idempotent and import has not
        # been acknowledged. Every validation preceded either local write.
        j.remember_candidate(row["run_id"], candidate["id"], key, body, first)

    def _research(self) -> int:
        j = self.journal
        rows = j.pending_research()
        for row in rows:
            error = ""
            try:
                task = _object(json.loads(row["task"]))
                result = _object(json.loads(row["body"]))
                for candidate_id in task["candidate_ids"]:
                    try:
                        candidate = j.candidate(row["run_id"], candidate_id)
                        if candidate is None:
                            # Supplemental tasks may not name a discovered lead.
                            continue
                        projection = notion_content.material_projection(
                            _object(json.loads(candidate["body"])),
                            key=candidate["entity_key"],
                            first_seen=datetime.datetime.fromisoformat(
                                candidate["first_seen"]
                            )
                            .date()
                            .isoformat(),
                            run_id=row["run_id"],
                            evidence=result["packets"],
                            progress="已研究",
                            fixture=self.historical(row["created_at"]),
                        )
                        j.enqueue("material", projection)
                    except (ValueError, KeyError, TypeError) as exc:
                        error = _failure("research", row["digest"], exc)
            except (ValueError, KeyError, TypeError) as exc:
                error = _failure("research", row["digest"], exc)
            j.mark_import("research", row["digest"], row["digest"], error)
        return len(rows)

    def _repair_links(self) -> None:
        # Discovery imports and a ready edition can arrive in different passes.
        # Relations therefore converge independently of edition updated_at and
        # without regenerating/reappending its frozen body.
        for row in self.journal.editions_for_links():
            try:
                self._link(
                    row["key"],
                    row["run_id"],
                    _object(json.loads(row["body"])),
                    _objects(row["snapshot"]),
                )
            except (ValueError, KeyError, TypeError) as exc:
                self.journal.mark_import(
                    "relations",
                    row["key"],
                    "invalid",
                    _failure("relation", row["key"], exc),
                )

    def _editions(self) -> int:
        j = self.journal
        rows = j.pending_editions()
        for row in rows:
            digest = "invalid"
            error = ""
            try:
                edition = _object(json.loads(row["body"]))
                updated_at = edition.get("updated_at", "invalid")
                if not isinstance(updated_at, str):
                    raise ValueError("notion_edition_update_invalid")
                digest = updated_at
                if not edition.get("rendered"):
                    continue
                packets = _objects(row["snapshot"])
                edition_type = "日常"
                run_id = row["run_id"] or ""
                if edition["is_fixture"] or self.historical(
                    edition["created_at"]
                ):
                    edition_type = "测试"
                elif j.is_verification(edition["id"]):
                    edition_type = "修订"
                elif not j.is_daily_run(run_id, edition["issue_date"]):
                    edition_type = "测试"
                projection = notion_content.edition_projection(
                    edition,
                    run_id=run_id,
                    packets=packets,
                    include_personal=self.include_personal,
                    edition_type=edition_type,
                )
                j.enqueue("edition", projection)
                self._link(projection.key, run_id, edition, packets)
            except (ValueError, KeyError, TypeError) as exc:
                error = _failure("edition", row["id"], exc)
            j.mark_import(
                "edition",
                row["id"],
                digest,
                error,
            )
        return len(rows)

    def _link(
        self,
        edition_key: str,
        run_id: str,
        edition: types.Payload,
        packets: list[types.Payload],
    ) -> None:
        """Link only source identities actually cited in the edition."""
        used = citations(edition["draft"])
        keys: set[str] = set()
        for packet in packets:
            for source in packet["content"]["sources"]:
                if packet["id"] + "/" + source["id"] in used:
                    try:
                        keys.update(notion_journal.material_aliases(source))
                    except ValueError:
                        pass
        for candidate in self.journal.candidates(run_id):
            aliases = notion_journal.material_aliases(
                _object(json.loads(candidate["body"]))
            )
            if set(aliases) & keys:
                self.journal.link(edition_key, candidate["entity_key"])
