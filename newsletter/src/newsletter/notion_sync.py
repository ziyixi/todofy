"""Independent Notion consumer that reads back unknown external outcomes.

It never imports mail/model clients. Provider failure cannot alter an edition or
its send state. The service owns one consumer; operator tools use the same lock.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import time
import urllib.parse as parse

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.notion_api as notion_api
import newsletter.notion_intake as notion_intake
import newsletter.notion_journal as notion_journal
import newsletter.types as types

logger = logging.getLogger(__name__)


def _link_signature(url: str | None) -> str | None:
    """Ignore Notion's colon escaping in query values, not distinct URLs.

    In particular EUR-Lex's ``uri=CELEX:...`` is stored as ``uri=CELEX%3A...``.
    Keep this readback equivalence narrow: no decoding of paths, separators,
    parameter names, fragments, plus signs, or reordering query parameters.
    The source blocks, their hashes and the actual outgoing links stay intact.
    """
    if url is None:
        return None
    base, fragment_mark, fragment = url.partition("#")
    path, query_mark, query = base.partition("?")
    params = []
    for param in query.split("&"):
        name, equals, value = param.partition("=")
        params.append(
            name + equals + re.sub("%3a", ":", value, flags=re.IGNORECASE)
        )
    return path + query_mark + "&".join(params) + fragment_mark + fragment


def _rich_text(parts: list[types.Payload]) -> list[types.Payload]:
    result: list[types.Payload] = []
    for part in parts:
        if part.get("type", "text") != "text":
            raise ValueError("notion_remote_body_conflict")
        text = part["text"]
        annotations = {
            key: value
            for key, value in part.get("annotations", {}).items()
            if value and not (key == "color" and value == "default")
        }
        formatting = {
            "link": _link_signature((text.get("link") or {}).get("url")),
            "annotations": annotations,
        }
        if result and result[-1]["format"] == formatting:
            result[-1]["text"] += text["content"]
        else:
            result.append({"text": text["content"], "format": formatting})
    return result


def block_signature(
    block: types.Payload, *, image_name: str = ""
) -> types.Payload:
    """Discard transport IDs and defaults, retaining meaningful body content."""
    kind = block["type"]
    body = block[kind]
    if block.get("has_children") or body.get("children"):
        raise ValueError("notion_remote_body_conflict")
    result: types.Payload = {"type": kind}
    if kind == "divider":
        return result
    if kind == "image":
        if body.get("type") == "file_upload":
            if not image_name:
                raise ValueError("notion_remote_image_conflict")
            result["filename"] = image_name
        elif body.get("type") == "file":
            result["filename"] = parse.unquote(
                parse.urlsplit(body["file"]["url"]).path.rsplit("/", 1)[-1]
            )
        else:
            raise ValueError("notion_remote_image_conflict")
        result["caption"] = _rich_text(body.get("caption", []))
        return result
    if kind not in {
        "paragraph",
        "heading_1",
        "heading_2",
        "heading_3",
        "bulleted_list_item",
        "numbered_list_item",
        "quote",
    }:
        raise ValueError("notion_remote_body_conflict")
    result["text"] = _rich_text(body.get("rich_text", []))
    if body.get("color", "default") != "default":
        result["color"] = body["color"]
    if body.get("is_toggleable"):
        result["is_toggleable"] = True
    return result


def _image_name(version: types.Payload) -> str:
    return (
        "chart-"
        + hashlib.sha256(base64.b64decode(version["chart"])).hexdigest()
        + ".png"
    )


def version_blocks(version: types.Payload) -> list[types.Payload]:
    """Resolve chart placeholders from an immutable version's upload receipt."""
    blocks = json.loads(version["blocks"])
    if not isinstance(blocks, list):
        raise ValueError("notion_blocks_invalid")
    for i, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise ValueError("notion_blocks_invalid")
        if block["type"] == "_newsletter_chart":
            if not version["upload_id"]:
                raise ValueError("notion_chart_not_uploaded")
            blocks[i] = {
                "object": "block",
                "type": "image",
                "image": {
                    "type": "file_upload",
                    "file_upload": {"id": version["upload_id"]},
                    "caption": block["_newsletter_chart"].get("caption", []),
                },
            }
    return blocks


def _chunk(blocks: list[types.Payload], offset: int) -> list[types.Payload]:
    batch: list[types.Payload] = []
    for block in blocks[offset : offset + 80]:
        proposed = [*batch, block]
        if (
            len(contracts.canonical_json({"children": proposed}).encode())
            > 400_000
        ):
            break
        batch = proposed
    if offset < len(blocks) and not batch:
        raise ValueError("notion_block_capacity")
    return batch


class NotionSync:
    """Project durable versions and reconcile uncertain external outcomes."""

    def __init__(
        self,
        journal: notion_journal.NotionJournal,
        api: notion_api.NotionWorkspace,
        *,
        include_personal: bool,
    ) -> None:
        self.journal, self.api = journal, api
        self.intake = notion_intake.NotionIntake(
            journal, include_personal=include_personal
        )

    async def _create(self, entity: types.Payload) -> None:
        key, kind = entity["key"], entity["kind"]
        pages = await self.api.lookup(kind, key)
        if len(pages) > 1:
            raise ValueError("notion_duplicate_sync_key")
        if pages:
            page = pages[0]
            if page.get("in_trash", page.get("archived", False)):
                raise ValueError("notion_remote_page_trashed")
            self.journal.confirm_page(key, page["id"])
            return
        if entity["create_state"] == "unknown":
            # An absent read does not prove a timed-out write cannot still land.
            raise adapters.AdapterError(
                "NOTION_CREATE_UNCONFIRMED", ambiguous=True
            )
        properties = self.journal.desired(entity)
        self.journal.begin_create(key)
        try:
            page_id = await self.api.create(kind, properties)
        except BaseException as exc:
            self.journal.fail_create(
                key,
                ambiguous=not isinstance(exc, adapters.AdapterError)
                or exc.ambiguous,
            )
            raise
        self.journal.confirm_page(
            key, page_id, contracts.content_hash(properties)
        )

    def _expected_prefix(
        self, entity: types.Payload, current: types.Payload
    ) -> list[types.Payload]:
        expected: list[types.Payload] = []
        for version in self.journal.versions(entity["key"]):
            if version["seq"] > current["seq"]:
                break
            blocks = version_blocks(version)
            count = (
                version["offset"]
                if version["seq"] == current["seq"]
                else len(blocks)
            )
            expected.extend(
                block_signature(block, image_name=_image_name(version))
                for block in blocks[:count]
            )
        return expected

    async def _reconcile_unknown(
        self, entity: types.Payload, version: types.Payload
    ) -> None:
        """Acknowledge an uncertain append by reading, never by repeating it."""
        blocks = version_blocks(version)
        prefix = self._expected_prefix(entity, version)
        # Old receipts contain signatures made before a readback normalization
        # fix. Rebuild from the immutable payload, preserving the original
        # receipt's block count (not today's chunk-size policy).
        receipt = json.loads(version["pending_chunk"])
        if not isinstance(receipt, list) or not receipt:
            raise ValueError("notion_invalid_append_receipt")
        offset = version["offset"] + len(receipt)
        if offset > len(blocks):
            raise ValueError("notion_invalid_append_receipt")
        pending = [
            block_signature(block, image_name=_image_name(version))
            for block in blocks[version["offset"] : offset]
        ]
        observed = [
            block_signature(block)
            for block in await self.api.children(entity["page_id"])
        ]
        if observed == prefix + pending:
            self.journal.acknowledge_append(
                version["seq"], offset, complete=offset == len(blocks)
            )
            return
        if observed == prefix:
            raise adapters.AdapterError(
                "NOTION_APPEND_UNCONFIRMED", ambiguous=True
            )
        raise ValueError("notion_remote_body_conflict")

    async def _recover_conflict(self, entity: types.Payload) -> None:
        """Only read to see whether a previously conflicting body now matches.

        This covers a provider's harmless storage normalization after an
        upgrade, or a human undoing their edit. Genuine differences remain
        quarantined; duplicate identities and property conflicts aren't reset.
        """
        versions = [
            v
            for v in self.journal.versions(entity["key"])
            if v["state"] != "done"
        ]
        if not entity["page_id"] or not versions:
            raise ValueError("notion_unresolved_projection_conflict")
        version = versions[0]
        if version["state"] == "unknown":
            await self._reconcile_unknown(entity, version)
        elif version["state"] == "pending":
            prefix = self._expected_prefix(entity, version)
            observed = [
                block_signature(block)
                for block in await self.api.children(entity["page_id"])
            ]
            if observed != prefix:
                raise ValueError("notion_remote_body_conflict")
        else:
            raise ValueError("notion_unresolved_projection_conflict")
        self.journal.resolve_conflict(entity["key"])

    async def _append(
        self, entity: types.Payload, version: types.Payload
    ) -> None:
        j = self.journal
        if version["state"] == "unknown":
            await self._reconcile_unknown(entity, version)
            return
        has_unattached_chart = any(
            block["type"] == "_newsletter_chart"
            for block in json.loads(version["blocks"])[version["offset"] :]
        )
        if (
            version["chart"]
            and version["state"] == "pending"
            and has_unattached_chart
            and (
                not version["upload_id"]
                or time.time() - version["upload_at"] > 3300
            )
        ):
            # A lost upload alone creates no visible page/content; replacing an
            # unattached expiring upload is safe and is not a repeated append.
            upload_id = await self.api.upload_png(
                base64.b64decode(version["chart"], validate=True)
            )
            j.record_upload(version["seq"], upload_id, time.time())
            return
        blocks = version_blocks(version)
        prefix = self._expected_prefix(entity, version)
        chunk = _chunk(blocks, version["offset"])
        expected_chunk = [
            block_signature(block, image_name=_image_name(version))
            for block in chunk
        ]
        if not chunk:
            j.finish_version(version["seq"])
            return
        # Check the existing managed page before each mutation, including after
        # journal restoration. Human edits are never silently deleted/replaced.
        observed = [
            block_signature(block)
            for block in await self.api.children(entity["page_id"])
        ]
        if observed == prefix + expected_chunk:
            # Recover acknowledgement loss across a restored local checkpoint.
            offset = version["offset"] + len(chunk)
            j.acknowledge_append(
                version["seq"], offset, complete=offset == len(blocks)
            )
            return
        if observed != prefix:
            raise ValueError("notion_remote_body_conflict")
        j.begin_append(version["seq"], expected_chunk)
        try:
            response = await self.api.append(entity["page_id"], chunk)
            acknowledged = [
                block_signature(block, image_name=_image_name(version))
                for block in response
            ]
            if acknowledged != expected_chunk:
                raise adapters.AdapterError(
                    "NOTION_APPEND_UNCONFIRMED", ambiguous=True
                )
        except BaseException as exc:
            j.fail_append(
                version["seq"],
                ambiguous=not isinstance(exc, adapters.AdapterError)
                or exc.ambiguous,
            )
            raise
        offset = version["offset"] + len(chunk)
        j.acknowledge_append(
            version["seq"], offset, complete=offset == len(blocks)
        )

    async def step(self) -> bool:
        """Advance at most one due entity without repeating uncertain writes."""
        with self.journal.store.deployment.activity(
            "notion", required=False
        ) as admitted:
            if not admitted:
                return False
            j = self.journal
            for entity in j.due_entities(time.time()):
                key = entity["key"]
                try:
                    if entity["create_state"] == "conflict":
                        await self._recover_conflict(entity)
                    elif not entity["page_id"]:
                        await self._create(entity)
                    else:
                        versions = [
                            v for v in j.versions(key) if v["state"] != "done"
                        ]
                        if versions:
                            await self._append(entity, versions[0])
                        else:
                            desired = j.desired(entity)
                            if (
                                contracts.content_hash(desired)
                                == entity["applied_hash"]
                            ):
                                continue
                            # Assignment PATCH may reapply the same managed
                            # property values after an unknown response.
                            await self.api.patch(
                                entity["kind"], entity["page_id"], desired
                            )
                            j.acknowledge_properties(
                                key, contracts.content_hash(desired)
                            )
                    j.clear_error(key)
                except asyncio.CancelledError:
                    raise
                except adapters.AdapterError as exc:
                    j.retry(key, exc.code)
                    logger.warning("Notion projection deferred: %s", exc.code)
                except (ValueError, KeyError, TypeError) as exc:
                    j.quarantine(key)
                    j.retry(key, "NOTION_PROJECTION_CONFLICT")
                    diagnostics.record_failure(
                        logger,
                        phase="notion_projection",
                        error=exc,
                        reference=key,
                    )
                return True
            return False

    async def run(self) -> None:
        """Scan frozen artifacts and project them until cancelled."""
        next_scan = 0.0
        while True:
            phase = "notion_intake"
            try:
                if time.monotonic() >= next_scan:
                    with self.journal.store.deployment.activity(
                        "notion_intake", required=False
                    ) as admitted:
                        imported = self.intake.scan() if admitted else 0
                    next_scan = time.monotonic() + (1 if imported else 60)
                phase = "notion_projection"
                worked = await self.step()
            except asyncio.CancelledError:
                raise
            # Isolate the optional mirror; keep source data out of diagnostics.
            except Exception as exc:  # noqa: BLE001
                # Do not expose source bodies, private events, paths or tokens.
                diagnostics.record_failure(logger, phase=phase, error=exc)
                worked = False
            await asyncio.sleep(0.6 if worked else 5)
