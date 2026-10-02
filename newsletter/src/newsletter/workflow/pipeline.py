"""Connect durable workflow steps to frozen editions without sending."""

from __future__ import annotations

import asyncio
import copy
import datetime
import logging
import pathlib

import newsletter.collection.collector as newsletter_collection_collector
import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.collection.pipeline as pipeline
import newsletter.collection.repository as repository
import newsletter.collection.source_guides as source_guides
import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.diagnostics as diagnostics
import newsletter.editor as newsletter_editor
import newsletter.settings as newsletter_settings
import newsletter.store as store
import newsletter.types as types
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as newsletter_workflow_engine
import newsletter.workflow.nodes as newsletter_workflow_nodes
import newsletter.workflow.publication as workflow_publication
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.sources as sources
import newsletter.workflow.state as newsletter_workflow_state
import newsletter.workflow.story_nodes as story_nodes
import newsletter.workflow.story_recipe as story_recipe
import newsletter.workflow.types as newsletter_workflow_types

_LOGGER = logging.getLogger(__name__)


def freeze_workflow(
    settings: newsletter_settings.Settings,
    state: newsletter_workflow_state.WorkflowState,
    issue_date: str,
) -> tuple[list[newsletter_collection_instructions.Instruction], types.Payload]:
    """Freeze the recipe, sources, history and policy for one issue date."""
    configuration = (
        content_config.load_active(settings.content_config_dir)
        if settings.content_config_dir
        else None
    )
    definition = (
        content_config.config_definition(configuration)
        if configuration
        else newsletter_workflow_definition.load_definition(
            settings.workflow_file
        )
    )
    newsletter_workflow_nodes.validate_recipe(definition)
    if (
        settings.notion_backend == "notion"
        and settings.notion_v2
        and not story_recipe.is_story_recipe(definition)
    ):
        raise ValueError(
            "Notion V2 requires the story publication workflow, not "
            "legacy projection"
        )
    instructions = (
        content_config.config_instructions(configuration["files"])
        if configuration
        else source_guides.load_discovery_instructions(settings.discovery_dir)
    )
    policy = {}
    for name in ("editorial.md", "reader-profile.md"):
        if configuration:
            policy[name] = configuration["files"]["policy/" + name]
            continue
        filename = (
            "story-editorial.md"
            if name == "editorial.md"
            and story_recipe.is_story_recipe(definition)
            else name
        )
        path = newsletter_editor.POLICY_DIR / filename
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > 100_000
        ):
            raise ValueError("Invalid editorial policy")
        policy[name] = path.read_text(encoding="utf-8")
    editions = [
        {
            "issue_date": e["issue_date"],
            "title": e.get("draft", {}).get("title", ""),
        }
        for e in state.store.recent_history()
    ]
    return instructions, {
        "definition": definition.snapshot(),
        "inputs": {
            "issue_date": issue_date,
            "instructions": [item.snapshot() for item in instructions],
            "history": state.history(issue_date),
            "pending_stories": workflow_publication.PublicationRepository(
                state.store
            ).pending_history(issue_date)
            if story_recipe.is_story_recipe(definition)
            else [],
            "editions": editions,
            "policy": policy,
            "started_at": datetime.datetime.now(datetime.UTC).isoformat(),
            "timeout_seconds": settings.workflow_timeout_seconds,
            "model": settings.model,
            **({"content_config": configuration} if configuration else {}),
        },
    }


class DagPipeline(pipeline.CollectionPipeline):
    """Bridge durable DAG execution to frozen editions and publication."""

    def __init__(
        self,
        runs: repository.RunRepository,
        collector: newsletter_collection_collector.Collector,
        workspace: pathlib.Path,
        timeout: float,
        max_packets: int,
        *,
        editor: newsletter_editor.CodexEditor,
        recipe_path: pathlib.Path | None = None,
    ) -> None:
        super().__init__(runs, collector, workspace, timeout, max_packets)
        self.editor = editor
        self.recipe_path = (
            recipe_path
            or pathlib.Path(__file__).parents[1] / "workflows" / "daily.yaml"
        )
        self.repository = newsletter_workflow_repository.WorkflowRepository(
            runs.store
        )
        self.state = newsletter_workflow_state.WorkflowState(runs.store)
        self.publications = workflow_publication.PublicationRepository(
            runs.store
        )

    def has_priority_work(self) -> bool:
        """Keep optional Notion mirroring outside publication deadlines."""
        for run in self.runs.queued_collecting():
            snapshot = self.runs.workflow_snapshot(run["id"])
            if snapshot is not None and story_recipe.is_story_recipe(
                newsletter_workflow_definition.parse_definition(
                    snapshot["definition"]
                )
            ):
                return True
        return False

    def recover(self) -> None:
        """Recover interrupted attempts without replaying provider work."""
        self.repository.recover()

    def receipt(self, run_id: str) -> types.Payload:
        """Read collection, workflow, usage and publication receipts."""
        run = self.runs.get(run_id)
        snapshot = self.runs.workflow_snapshot(run_id)
        if snapshot is None:
            return run
        if self.repository.exists(run_id):
            run["workflow"] = self.progress(run_id)
        else:
            definition = newsletter_workflow_definition.parse_definition(
                snapshot["definition"]
            )
            run["workflow"] = {
                "id": definition.id,
                "definition_hash": definition.digest,
                "state": "queued",
                "nodes": [],
            }
        run["usage"] = self.state.usage(run_id)
        publication = self.publications.get_publication(run_id)
        if publication is not None:
            run["publication"] = publication["coverage"]
        return run

    def progress(self, run_id: str) -> types.Payload:
        """Read graph progress and its separately frozen repair continuation."""
        progress = self.graph_progress(run_id)
        repair = self.state.repair(run_id)
        if repair:
            try:
                continuation = self.graph_progress(repair["child_run_id"])
            except newsletter_workflow_repository.WorkflowError:
                definition = newsletter_workflow_definition.parse_definition(
                    repair["snapshot"]["definition"]
                )
                continuation = {
                    "id": definition.id,
                    "definition_hash": definition.digest,
                    "state": "queued",
                    "nodes": [],
                }
            progress["continuations"] = [continuation]
        return progress

    def graph_progress(self, run_id: str) -> types.Payload:
        """Describe persisted node outcomes and completed item counts."""
        run = self.repository.get(run_id)
        definition = newsletter_workflow_definition.parse_definition(
            self.repository.snapshot(run_id)["definition"]
        )
        nodes = []
        for node in definition.nodes:
            state = run["nodes"][node.id]
            nodes.append(
                {
                    "id": node.id,
                    "type": node.type,
                    "state": state["state"],
                    "completed_items": sum(
                        item["state"] == "succeeded" for item in state["items"]
                    ),
                    "failed_items": sum(
                        item["state"] in {"failed", "unknown"}
                        for item in state["items"]
                    ),
                    "error_code": state["error_code"],
                }
            )
        count = 0
        for node in definition.nodes:
            if (
                node.type == "deduplicate"
                and run["nodes"][node.id]["state"] == "succeeded"
            ):
                count = len(
                    self.repository.output(run_id, node.id)["candidates"]
                )
        return {
            "id": definition.id,
            "definition_hash": definition.digest,
            "state": run["state"],
            "nodes": nodes,
            "candidate_count": count,
            "research_count": sum(
                n["completed_items"]
                for n in nodes
                if n["type"] in {"research", "story_brief", "story_deep"}
            ),
        }

    async def collect_next(self) -> bool:
        """Advance one claimed collection run within its frozen deadline."""
        claimed = self.runs.claim(resume=True)
        if claimed is None:
            return False
        run, _ = claimed
        snapshot = self.runs.workflow_snapshot(run["id"])
        if snapshot is None:
            self.runs.update(run["id"], state="queued")
            return await super().collect_next()
        try:
            repair = self.state.repair(run["id"])
            execution_id = run["id"]
            if repair:
                snapshot = repair["snapshot"]
                execution_id = repair["child_run_id"]
            definition = newsletter_workflow_definition.parse_definition(
                snapshot["definition"]
            )
            if repair:
                newsletter_workflow_nodes.validate_revision_subgraph(definition)
            else:
                newsletter_workflow_nodes.validate_recipe(definition)
            status = self.repository.start(
                execution_id, definition, snapshot["inputs"]
            )
            # A crash may leave completed artifacts without an edition receipt.
            # Recover that local, idempotent tail even after the model deadline.
            if self.finish_graph(run, definition, execution_id, status):
                return True
            elapsed = (
                datetime.datetime.now(datetime.UTC)
                - datetime.datetime.fromisoformat(
                    snapshot["inputs"]["started_at"]
                )
            ).total_seconds()
            remaining = snapshot["inputs"]["timeout_seconds"] - elapsed
            if remaining <= 0:
                if story_recipe.is_story_recipe(definition):
                    self.publish_available(
                        run, definition, reason="workflow_deadline"
                    )
                else:
                    self.runs.update(
                        run["id"],
                        state="blocked",
                        error_code="workflow_deadline",
                    )
                return True
            # The frozen run's model, not a newly edited setting, owns this
            # attempt.
            editor = newsletter_editor.CodexEditor(
                self.editor.codex_home,
                model=snapshot["inputs"]["model"],
                timeout_seconds=900,
            )
            node_class = (
                story_nodes.StoryNodes
                if story_recipe.is_story_recipe(definition)
                else newsletter_workflow_nodes.EditorialNodes
            )
            handlers = node_class(
                self.runs.store, definition, editor, self.workspace
            )
            engine = newsletter_workflow_engine.WorkflowEngine(
                self.repository,
                {node.type: handlers for node in definition.nodes},
            )
            try:
                async with asyncio.timeout(remaining):
                    await engine.step(execution_id)
            except TimeoutError:
                if not story_recipe.is_story_recipe(definition):
                    raise
                self.publish_available(
                    run, definition, reason="workflow_deadline"
                )
                return True
            status = self.repository.get(execution_id)
            self.finish_graph(run, definition, execution_id, status)
            return True
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            self.runs.update(
                run["id"], state="blocked", error_code="workflow_deadline"
            )
        except store.StoreError as error:
            if error.code != "busy":
                self.runs.update(
                    run["id"], state="failed", error_code="workflow_storage"
                )
        except Exception as exc:  # noqa: BLE001
            # Isolate this run or optional tail without logging payloads.
            diagnostics.record_failure(
                _LOGGER,
                phase="workflow_collect",
                error=exc,
                reference=run["id"],
            )
            self.runs.update(
                run["id"], state="failed", error_code="workflow_invalid_result"
            )
        return True

    def finish_graph(
        self,
        run: types.Payload,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        execution_id: str,
        status: newsletter_workflow_types.WorkflowRun,
    ) -> bool:
        """Finish a terminal graph using only its durable result artifacts."""
        if story_recipe.is_story_recipe(definition):
            frozen = self.publications.get_publication(run["id"])
            if frozen is not None or status["state"] in {
                "failed",
                "unknown",
                "succeeded",
            }:
                self.publish_available(
                    run,
                    definition,
                    reason="completed"
                    if status["state"] == "succeeded"
                    else "research_interrupted",
                )
                return True
            return False
        if status["state"] in {"failed", "unknown"}:
            codes = [
                node["error_code"]
                for node in status["nodes"].values()
                if node["state"] in {"failed", "unknown"}
            ]
            self.runs.update(
                run["id"],
                state="blocked",
                error_code="workflow_" + (codes[0] if codes else "failed"),
            )
            return True
        if status["state"] == "succeeded":
            self.queue_edition(run, definition, execution_id=execution_id)
            return True
        return False

    def publish_available(
        self,
        run: types.Payload,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        *,
        reason: str,
    ) -> None:
        """Publish approved units locally without another model pass."""
        try:
            if not self.publications.plan(run["id"]):
                raise workflow_publication.PublicationError(
                    "no_publishable_content"
                )
            snapshot = self.runs.workflow_snapshot(run["id"])
            config = (
                snapshot["inputs"].get("content_config") if snapshot else None
            )
            result = story_nodes.freeze_publication(
                self.publications,
                run["id"],
                run["issue_date"],
                reason=reason,
                max_features=config["editorial"]["max_deep"] if config else 2,
            )
        except workflow_publication.PublicationError as error:
            self.runs.update(run["id"], state="blocked", error_code=error.code)
            return
        required = adopted_packets(result["draft"])
        edition = self.runs.store.prepare(
            {
                "request_key": "collection:" + run["id"],
                "issue_date": run["issue_date"],
                "packet_ids": [packet["id"] for packet in result["packets"]],
            },
            workflow_binding={
                "run_id": run["id"],
                "result": {
                    "draft": result["draft"],
                    "review": result["review"],
                },
                "required_packets": required,
                "projection_required": False,
            },
        )
        self.runs.store.finish(edition["id"], publication=result["coverage"])
        self.runs.update(
            run["id"], state="editing", edition_id=edition["id"], error_code=""
        )
        try:
            self.archive_candidates(
                run, definition, required, result["packets"]
            )
        except Exception as exc:  # noqa: BLE001
            # Isolate this run or optional tail without logging payloads.
            diagnostics.record_failure(
                _LOGGER,
                phase="workflow_archive",
                error=exc,
                reference=run["id"],
            )
            self.state.archive_result(
                run["id"], error_code="candidate_archive_failed"
            )

    def queue_edition(
        self,
        run: types.Payload,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        *,
        execution_id: str | None = None,
    ) -> None:
        """Bind a completed review and adopted evidence to a frozen edition."""
        execution_id = execution_id or run["id"]
        review_node = next(
            (node for node in definition.nodes if node.type == "final_review"),
            next(
                (node for node in definition.nodes if node.type == "review"),
                None,
            ),
        )
        if review_node is None:
            raise ValueError("Missing publication review")
        result = self.repository.output(execution_id, review_node.id)
        contracts.validate_draft(result["draft"], result["packets"])
        required = adopted_packets(result["draft"])
        edition = self.runs.store.prepare(
            {
                "request_key": "collection:" + execution_id,
                "issue_date": run["issue_date"],
                "packet_ids": [p["id"] for p in result["packets"]],
            },
            workflow_binding={
                "run_id": execution_id,
                "result": {
                    "draft": result["draft"],
                    "review": result["review"],
                },
                "required_packets": required,
            },
        )
        self.runs.update(
            run["id"], state="editing", edition_id=edition["id"], error_code=""
        )
        if execution_id != run["id"]:
            # The original index and research writes already have durable
            # receipts.
            # Never rewrite/recreate them just because a held draft is revised.
            return
        try:
            self.archive_candidates(
                run, definition, required, result["packets"]
            )
        except Exception as exc:  # noqa: BLE001
            # Isolate this run or optional tail without logging payloads.
            diagnostics.record_failure(
                _LOGGER,
                phase="workflow_archive",
                error=exc,
                reference=run["id"],
            )
            # Candidate browsing is optional; failure must not discard a frozen
            # edition or hide the separately enforced adopted-material barrier.
            self.state.archive_result(
                run["id"], error_code="candidate_archive_failed"
            )

    def archive_candidates(
        self,
        run: types.Payload,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        required: list[str],
        packets: list[types.Payload],
    ) -> None:
        """Archive selected-topic provenance independently of publication."""
        node = next(
            node for node in definition.nodes if node.type == "deduplicate"
        )
        candidates = self.repository.output(run["id"], node.id)["candidates"]
        if not candidates:
            return
        source_keys = set().union(
            *(
                sources.identity_keys({"url": source["url"]})
                for packet in packets
                if packet["id"] in required
                for source in packet["content"]["sources"]
            )
        )
        used = [
            c["id"]
            for c in candidates
            if sources.identity_keys(c) & source_keys
        ]
        self.state.mark(
            used, "used", "本期正文引用关联的公开来源；不推断读者点击偏好。"
        )
        rows = [
            f"本期 {len(candidates)} 条候选。以下为发现元数据，"
            "不是已验证研究结论；邮件只采用部分深读材料。"
        ]
        for index, candidate in enumerate(candidates, 1):
            status = (
                "本期关联采用" if candidate["id"] in used else "候选/继续观察"
            )
            rows.append(
                f"{index}. [{status}] {candidate['title'][:180]}\n"
                f"{candidate['summary'][:600]}\n"
                f"为何现在关注：{candidate['why_now'][:300]}\n"
                f"见来源 {index}；发现元数据尚非结论。"
            )
        body = {
            "title": run["issue_date"] + " · 今日选题池",
            "body": "\n\n".join(rows),
            "sources": [
                {
                    "id": "candidate-" + str(i),
                    "title": c["title"][:500],
                    "url": c["url"],
                    "excerpt": "发现元数据；未在此页认证研究结论。",
                    "access_scope": "metadata",
                    "published_at": c["published_at"],
                }
                for i, c in enumerate(candidates, 1)
            ],
            "tags": ["candidate-index", "unverified", "workflow"],
        }
        contracts.validate_packet_body(body)
        packet = self.runs.store.put_packet(
            {
                "request_key": run["id"] + ":candidate-index",
                "workflow_id": "candidate-index",
                "content": body,
            },
            "workflow-index",
        )
        self.state.archive_result(run["id"], packet_id=packet["id"])

    def advance(self) -> bool:
        """Advance frozen editions through publication barriers."""
        changed = super().advance()
        for run in self.runs.active():
            if (
                self.runs.workflow_snapshot(run["id"]) is None
                or run["state"] != "editing"
                or not run["edition_id"]
            ):
                continue
            edition = self.runs.store.get(run["edition_id"])
            if edition["state"] in {"failed", "blocked"}:
                self.runs.update(
                    run["id"],
                    state=edition["state"],
                    error_code=edition.get(
                        "error_code", "workflow_editor_failed"
                    ),
                )
                changed = True
                continue
            if edition["state"] != "ready":
                continue
            binding = self.state.edition(edition["id"])
            if binding is not None and binding["projection_required"] is False:
                try:
                    self.state.assert_publishable(edition["id"])
                except store.StoreError:
                    self.runs.update(
                        run["id"],
                        state="blocked",
                        error_code="publication_evidence_invalid",
                    )
                else:
                    self.runs.update(run["id"], state="ready")
                changed = True
                continue
            states = self.runs.projection_states(
                binding["required_packets"] if binding else []
            )
            if not states or any(
                state in {"failed", "unknown"} for state in states
            ):
                self.runs.update(
                    run["id"],
                    state="blocked",
                    error_code="notion_projection_unconfirmed",
                )
                changed = True
            elif all(state == "done" for state in states):
                self.runs.update(run["id"], state="ready")
                changed = True
        return self.start_legacy_repair() or changed

    def start_legacy_repair(self) -> bool:
        """Resume an old editorial HOLD through a frozen two-node subgraph.

        New recipes already contain revision/final_review and never enter here.
        This bridge changes no old node, edition, request key or receipt.
        A crash between audit-record creation and queueing is resumable.
        """
        for run in self.runs.legacy_repair_candidates():
            if run.get(
                "error_code"
            ) != "editorial_review_failed" or not run.get("edition_id"):
                continue
            snapshot = self.runs.workflow_snapshot(run["id"])
            if snapshot is None:
                continue
            try:
                original = newsletter_workflow_definition.parse_definition(
                    snapshot["definition"]
                )
                newsletter_workflow_nodes.validate_recipe(original)
                if story_recipe.is_story_recipe(original):
                    continue
                if any(
                    node.type in {"revision", "final_review"}
                    for node in original.nodes
                ):
                    # A second HOLD is terminal, never a third review cycle.
                    continue
                repair = self.state.repair(run["id"])
                if repair and repair["source_edition_id"] != run["edition_id"]:
                    continue  # The continuation's revised edition also held.
                inputs = snapshot["inputs"]
                elapsed = (
                    datetime.datetime.now(datetime.UTC)
                    - datetime.datetime.fromisoformat(inputs["started_at"])
                ).total_seconds()
                if repair is None and elapsed >= inputs["timeout_seconds"]:
                    # Upgrading must not reset or extend a run's deadline.
                    continue
                if repair is None:
                    current = newsletter_workflow_definition.load_definition(
                        self.recipe_path
                    )
                    newsletter_workflow_nodes.validate_recipe(current)
                    roles = {node.type: node for node in current.nodes}
                    if not {"revision", "final_review"} <= roles.keys():
                        continue
                    definition = (
                        newsletter_workflow_definition.parse_definition(
                            {
                                "version": 1,
                                "id": "editorial-repair",
                                "nodes": [
                                    {
                                        "id": "revision",
                                        "type": "revision",
                                        "params": roles["revision"].params,
                                    },
                                    {
                                        "id": "final_review",
                                        "type": "final_review",
                                        "needs": ["revision"],
                                        "params": roles["final_review"].params,
                                    },
                                ],
                            }
                        )
                    )
                    newsletter_workflow_nodes.validate_revision_subgraph(
                        definition
                    )
                    review_node = next(
                        node for node in original.nodes if node.type == "review"
                    )
                    result = self.repository.output(run["id"], review_node.id)
                    binding = self.state.edition(run["edition_id"])
                    if binding is None or binding["result"] != {
                        "draft": result["draft"],
                        "review": result["review"],
                    }:
                        raise ValueError(
                            "Held result does not match its original artifact"
                        )
                    frozen = copy.deepcopy(inputs)
                    frozen.update(
                        prior_review_result=result,
                        parent_run_id=run["id"],
                        parent_definition_hash=original.digest,
                        parent_result_hash=contracts.content_hash(result),
                    )
                    repair = self.state.create_repair(
                        run["id"],
                        run["edition_id"],
                        definition.snapshot(),
                        frozen,
                    )
                definition = newsletter_workflow_definition.parse_definition(
                    repair["snapshot"]["definition"]
                )
                newsletter_workflow_nodes.validate_revision_subgraph(definition)
                self.repository.start(
                    repair["child_run_id"],
                    definition,
                    repair["snapshot"]["inputs"],
                )
                self.runs.update(run["id"], state="collecting", error_code="")
                return True
            except Exception as exc:  # noqa: BLE001
                # Isolate this run or optional tail without logging payloads.
                diagnostics.record_failure(
                    _LOGGER,
                    phase="workflow_repair",
                    error=exc,
                    reference=run["id"],
                )
                self.runs.update(
                    run["id"], error_code="workflow_repair_invalid"
                )
                return True
        return False


def adopted_packets(draft: types.Payload) -> list[str]:
    """Return every packet cited by body text, charts or reading cards."""
    references = [
        ref
        for section in draft["sections"]
        for paragraph in section["paragraphs"]
        for ref in paragraph["citations"]
    ]
    references += [
        ref
        for point in draft.get("chart", {}).get("points", [])
        for ref in point["citations"]
    ]
    if draft.get("recommended_reading"):
        references.append(draft["recommended_reading"]["citation"])
        references.extend(
            draft["recommended_reading"].get("supporting_citations", [])
        )
    return sorted({ref.split("/", 1)[0] for ref in references})
