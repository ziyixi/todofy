"""One-shot collection orchestration; no daily scheduling."""

import asyncio
import logging
import pathlib

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.collector as newsletter_collection_collector
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.errors as errors
import newsletter.store as store


class CollectionPipeline:
    """Advance frozen collection directions without scheduling new issues."""

    def __init__(
        self,
        runs: repository.RunRepository,
        collector: newsletter_collection_collector.Collector,
        workspace: pathlib.Path,
        timeout: float,
        max_packets: int,
    ) -> None:
        self.runs, self.collector = runs, collector
        self.workspace, self.timeout, self.max_packets = (
            workspace,
            timeout,
            max_packets,
        )

    def has_priority_work(self) -> bool:
        """Legacy runs require projection first; newer policies may override."""
        return False

    async def collect_next(self) -> bool:
        """Claim one queued run; retain failed work for explicit recovery."""
        claimed = self.runs.claim()
        if claimed is None:
            return False
        run, instructions = claimed
        count = 0
        current = ""
        try:
            for instruction in instructions:
                current = instruction.id
                self.runs.direction(run["id"], current, state="collecting")
                async with asyncio.timeout(self.timeout):
                    result = await self.collector.collect(
                        instruction,
                        run["issue_date"],
                        self.workspace / run["id"] / current,
                    )
                count += len(result.packets)
                if (
                    count > self.max_packets
                    or len(result.packets) > 2
                    or len(result.note) > 2000
                ):
                    raise errors.EditorError("invalid_output")
                requests = []
                for index, material in enumerate(result.packets):
                    request = contracts.parse_message(
                        {
                            "request_key": f"{run['id']}:{current}:{index}",
                            "workflow_id": current,
                            "content": material,
                        },
                        editorial_pb2.PutPacketRequest,
                    )
                    contracts.validate_request(request)
                    requests.append(contracts.to_dict(request))
                self.runs.save_direction(
                    run["id"], current, requests, result.note
                )
            self.runs.update(
                run["id"],
                state="projecting" if count else "blocked",
                error_code="" if count else "collection_no_findings",
            )
        except asyncio.CancelledError:
            self.runs.direction(run["id"], current, state="failed")
            self.runs.update(
                run["id"], state="failed", error_code="collection_interrupted"
            )
            raise
        except TimeoutError:
            self.runs.direction(run["id"], current, state="failed")
            self.runs.update(
                run["id"], state="failed", error_code="collection_timeout"
            )
        # A provider failure must not terminate unrelated durable queue work.
        except Exception as exc:  # noqa: BLE001
            diagnostics.record_failure(
                logging.getLogger(__name__),
                phase="collection",
                error=exc,
                reference=run["id"],
            )
            self.runs.direction(run["id"], current, state="failed")
            code = (
                "collection_" + exc.code
                if isinstance(exc, errors.EditorError)
                else "collection_invalid_result"
            )
            self.runs.update(run["id"], state="failed", error_code=code)
        return True

    def advance(self) -> bool:
        """Await confirmed material projection; never retry unknown writes."""
        changed = False
        for run in self.runs.active():
            if self.runs.workflow_snapshot(run["id"]) is not None:
                # The DAG gates adopted, not every discovered, material.
                continue
            packet_ids = [
                packet_id
                for direction in run["directions"]
                for packet_id in direction["packet_ids"]
            ]
            if run["state"] == "editing":
                edition = self.runs.store.get(run["edition_id"])
                if edition["state"] in {"failed", "blocked"}:
                    self.runs.update(
                        run["id"],
                        state=edition["state"],
                        error_code=edition.get("error_code", "editor_failed"),
                    )
                    changed = True
                    continue
                if edition["state"] != "ready":
                    continue
                packet_ids = edition["packet_ids"]
            states = self.runs.projection_states(packet_ids)
            if any(state in {"unknown", "failed"} for state in states):
                self.runs.update(
                    run["id"],
                    state="blocked",
                    error_code="notion_projection_unconfirmed",
                )
                changed = True
                continue
            if not all(state == "done" for state in states):
                continue
            if run["state"] == "editing":
                self.runs.update(run["id"], state="ready")
                changed = True
                continue
            try:
                # The edition's own idempotency key survives a crash between
                # these writes.
                edition = self.runs.store.prepare(
                    {
                        "request_key": "collection:" + run["id"],
                        "issue_date": run["issue_date"],
                        "packet_ids": packet_ids,
                    }
                )
            except store.StoreError as exc:
                if exc.code == "busy":
                    # Queued editions will free capacity; no external retry.
                    continue
                self.runs.update(
                    run["id"],
                    state="failed",
                    error_code="edition_enqueue_failed",
                )
                changed = True
                continue
            self.runs.update(
                run["id"], state="editing", edition_id=edition["id"]
            )
            changed = True
        return changed
