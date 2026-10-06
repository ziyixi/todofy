"""One serialized editor worker with a durable queue and bounded jobs."""

import asyncio
import logging
import pathlib
from typing import cast, Protocol

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.editor as newsletter_editor
import newsletter.email_templates as email_templates
import newsletter.errors as errors
import newsletter.rendering as rendering
import newsletter.store as newsletter_store
import newsletter.todofy as newsletter_todofy
import newsletter.types as types
import newsletter.usage as newsletter_usage
import newsletter.workflow.repository as repository
import newsletter.workflow.state as state

logger = logging.getLogger(__name__)


class Pipeline(Protocol):
    """Advance collection runs: the live topic DAG or the offline fixture."""

    def advance(self) -> bool:
        """Move runs whose local barriers are satisfied; report progress."""
        ...

    def has_priority_work(self) -> bool:
        """Report runs whose deadline outranks optional projection work."""
        ...

    async def collect_next(self) -> bool:
        """Advance one claimed collection run; report whether it worked."""
        ...


class Worker:
    """Prepare queued editions and advance local projection work serially."""

    def __init__(
        self,
        store: newsletter_store.Store,
        editor: newsletter_editor.Editor | None,
        notion: adapters.NotionAdapter,
        workspace: pathlib.Path,
        timeout: float,
        *,
        todofy: newsletter_todofy.TodofyAdapter | None = None,
        pipeline: Pipeline | None = None,
        skip_packet_projection: bool = False,
    ) -> None:
        self.store, self.editor, self.notion = store, editor, notion
        self.workspace, self.timeout = workspace, timeout
        self.wake = asyncio.Event()
        self.todofy: newsletter_todofy.TodofyAdapter = (
            todofy or newsletter_todofy.DisabledTodofy()
        )
        self.pipeline = pipeline
        self.skip_packet_projection = skip_packet_projection
        self.workflow_state = state.WorkflowState(store)

    async def personal_digest(
        self, edition: types.EditionRecord
    ) -> types.Payload:
        """Fetch optional private enrichment without failing the edition."""
        try:
            async with asyncio.timeout(50):
                digest = await self.todofy.fetch(edition["issue_date"])
            contracts.validate_personal_digest(digest)
            result = contracts.to_dict(
                contracts.parse_message(digest, editorial_pb2.PersonalDigest)
            )
            if not edition["is_fixture"] and result["is_fixture"]:
                return newsletter_todofy.unavailable_digest()
            return result
        except asyncio.CancelledError:
            raise
        # Optional provider or validation failures cannot veto the edition.
        except Exception as exc:  # noqa: BLE001
            diagnostics.record_failure(
                logger,
                phase="personal_digest",
                error=exc,
                reference=edition.get("id", ""),
            )
            return newsletter_todofy.unavailable_digest()

    def frozen_template(self, binding: types.Payload | None) -> str | None:
        """Resolve the exact execution snapshot, including repairs and replays.

        Older/manual bindings can predate the workflow input ledger entirely;
        only those use the packaged renderer. Invalid new snapshots fail closed
        instead of silently substituting a newer live template.
        """
        if binding is None:
            return None
        inputs = repository.frozen_inputs(self.store, binding["run_id"])
        return (
            email_templates.template_from_inputs(inputs)
            if inputs is not None
            else None
        )

    async def step(self) -> bool:
        """Advance one queued job or projection and report whether it worked."""
        with self.store.deployment.activity(
            "worker", required=False
        ) as admitted:
            if not admitted:
                return False
            if self.pipeline and self.pipeline.advance():
                return True
            claimed = self.store.claim()
            if claimed:
                edition, packets = claimed
                await self.prepare(edition, packets)
                return True
            if (
                self.pipeline
                and self.pipeline.has_priority_work()
                and await self.pipeline.collect_next()
            ):
                return True
            # Project immutable DAG snapshots independently.
            # Preserve receipts for writes that have actually completed.
            packet = (
                None
                if self.skip_packet_projection
                else self.store.claim_projection()
            )
            if packet:
                try:
                    async with asyncio.timeout(35):
                        await self.notion.project(packet)
                    self.store.projection_result(packet["id"], "done")
                except adapters.AdapterError as exc:
                    self.store.projection_result(
                        packet["id"], "unknown" if exc.ambiguous else "failed"
                    )
                # Unclassified provider failures have uncertain results.
                except Exception as exc:  # noqa: BLE001
                    self.store.projection_result(packet["id"], "unknown")
                    diagnostics.record_failure(
                        logger,
                        phase="packet_projection",
                        error=exc,
                        reference=packet["id"],
                    )
                except BaseException:
                    self.store.projection_result(packet["id"], "unknown")
                    raise
                return True
            return (
                await self.pipeline.collect_next() if self.pipeline else False
            )

    async def prepare(
        self, edition: types.EditionRecord, packets: list[types.Payload]
    ) -> None:
        """Prepare and freeze one edition, retaining safe recovery receipts."""
        phase = "workspace"
        try:
            workspace = self.workspace / edition["id"]
            workspace.mkdir(parents=True, mode=0o700, exist_ok=True)
            history = [
                {
                    "issue_date": e["issue_date"],
                    "title": e.get("draft", {}).get("title", ""),
                    "delivery_state": e["delivery_state"],
                }
                for e in self.store.recent_history()
            ]
            (workspace / "recent-history.json").write_text(
                contracts.canonical_json(history), encoding="utf-8"
            )
            async with asyncio.timeout(self.timeout):
                phase = "editor"
                binding = self.workflow_state.edition(edition["id"])
                scope_id = binding["run_id"] if binding else edition["id"]
                if binding:
                    frozen = binding["result"]
                    result = newsletter_editor.EditorResult(
                        frozen["draft"], frozen["review"]
                    )
                elif self.editor is None:
                    # Unbound editions come only from the retired legacy
                    # collection backend; nothing can draft them any more.
                    self.store.finish(
                        edition["id"],
                        state="failed",
                        error_code="legacy_editor_retired",
                    )
                    return
                else:
                    with newsletter_usage.usage_scope(
                        self.workflow_state.usage_sink(scope_id), "editor"
                    ):
                        result = await self.editor.prepare(
                            packets, edition["issue_date"], workspace
                        )
                phase = "editor_validation"
                # Shape and citation validation do not certify factual truth.
                # No remaining editor researches new packets here, so a draft
                # may cite only the edition's frozen packet snapshot.
                contracts.validate_draft(result.draft, packets)
                draft = contracts.to_dict(
                    contracts.parse_message(result.draft, editorial_pb2.Draft)
                )
                review = cast(
                    types.ReviewResult,
                    contracts.to_dict(
                        contracts.parse_message(
                            result.review, editorial_pb2.Review
                        )
                    ),
                )
                if len(review["findings"]) > 32 or any(
                    len(f) > 4000 for f in review["findings"]
                ):
                    raise errors.EditorError("invalid_output")
                if not review["passed"]:
                    self.store.finish(
                        edition["id"],
                        state="blocked",
                        draft=draft,
                        review=review,
                        error_code="editorial_review_failed",
                    )
                    return
            # Separate bounded budget: a slow optional Todofy must not consume
            # the editor's remaining deadline and fail the whole newsletter.
            # Private events never enter prompts, packets or public search.
            # The separate Notion edition archive requires an explicit opt-in.
            if (
                binding
                and binding.get("projection_required") is False
                and "personal_digest" in edition
            ):
                # A restarted render reuses the completed private summary.
                # This data never enters a model.
                contracts.validate_personal_digest(edition["personal_digest"])
                personal = contracts.to_dict(
                    contracts.parse_message(
                        edition["personal_digest"], editorial_pb2.PersonalDigest
                    )
                )
            else:
                personal = await self.personal_digest(edition)
            usage = self.workflow_state.usage(scope_id)
            phase = "rendering"
            self.store.finish(
                edition["id"], personal_digest=personal, usage=usage
            )
            rendered = await asyncio.to_thread(
                rendering.render_edition,
                draft,
                packets,
                edition["issue_date"],
                edition["is_fixture"],
                personal_digest=personal,
                usage=usage,
                template_source=self.frozen_template(binding),
            )
            # Freeze the precise serialized representation returned to clients.
            rendered = cast(
                types.RenderResult,
                contracts.to_dict(
                    contracts.parse_message(
                        rendered, editorial_pb2.RenderedEdition
                    )
                ),
            )
            self.store.finish(
                edition["id"],
                state="ready",
                draft=draft,
                review=review,
                rendered=rendered,
            )
        except asyncio.CancelledError:
            self.store.interrupt_preparation(edition["id"])
            raise
        except TimeoutError:
            self.store.finish(
                edition["id"], state="failed", error_code="editor_timeout"
            )
        except OSError:
            self.store.finish(
                edition["id"],
                state="failed",
                error_code="editor_workspace_error",
            )
        except errors.EditorError as exc:
            self.store.finish(
                edition["id"], state="failed", error_code=exc.code
            )
        # Keep one unexpected job failure from killing the serialized worker.
        except Exception as exc:  # noqa: BLE001
            diagnostics.record_failure(
                logger, phase=phase, error=exc, reference=edition["id"]
            )
            self.store.finish(
                edition["id"],
                state="failed",
                error_code="editor_invalid_result",
            )

    async def run(self) -> None:
        """Process work serially until the owner cancels the worker."""
        while True:
            self.wake.clear()
            if await self.step():
                continue
            await self.wake.wait()
