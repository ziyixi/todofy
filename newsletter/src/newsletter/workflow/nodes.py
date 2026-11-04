"""Public-content nodes without private-event access or mail sending."""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import pathlib
from typing import Any, cast

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.instructions as instructions
import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.errors as errors
import newsletter.model_io as model_io
import newsletter.store as newsletter_store
import newsletter.types as types
import newsletter.usage as usage
import newsletter.workflow.content as content
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as engine
import newsletter.workflow.feed_excerpts as feed_excerpts
import newsletter.workflow.researcher as researcher
import newsletter.workflow.sources as sources
import newsletter.workflow.state as newsletter_workflow_state
import newsletter.workflow.threads as workflow_threads


class EditorialNodes:
    """Run the shared discovery and selection stages of a topic recipe.

    StoryNodes adds the story planning, writing and publication stages. The
    whole-edition stages of the retired legacy recipe are gone; stored legacy
    runs keep their receipts but are never executed again.
    """

    def __init__(
        self,
        store: newsletter_store.Store,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        editor: newsletter_editor.ModelEditor,
        workspace: pathlib.Path,
    ) -> None:
        self.store, self.definition, self.editor, self.workspace = (
            store,
            definition,
            editor,
            workspace,
        )
        self.state = newsletter_workflow_state.WorkflowState(store)
        self.content = content.ContentPreparation(editor)
        self.researcher = researcher.Researcher()
        self.kinds = {node.id: node.type for node in definition.nodes}

    def inputs(self, ctx: engine.NodeContext, kind: str) -> list[Any]:
        """Return dependency artifacts with the requested frozen node type."""
        return [
            value
            for key, value in ctx.inputs.items()
            if self.kinds[key] == kind
        ]

    def one(
        self, ctx: engine.NodeContext, kind: str, default: Any = None
    ) -> Any:
        """Return the first matching dependency artifact or the default."""
        values = self.inputs(ctx, kind)
        return values[0] if values else default

    def coverage(self, ctx: engine.NodeContext) -> list[types.Payload]:
        """Describe direct and inherited dependency outcomes."""
        result = []
        for name, state in ctx.dependency_states.items():
            result.append(
                {
                    "stage": name,
                    "state": state["state"],
                    "degraded": state.get("degraded", False),
                    "error_code": state.get("error_code", ""),
                    "failures": [
                        {"id": item["id"], "error_code": item["error_code"]}
                        for item in state.get("items", [])
                        if item["state"] in {"failed", "unknown"}
                    ],
                }
            )
        for value in ctx.inputs.values():
            if isinstance(value, dict):
                result.extend(value.get("coverage", []))
        return result

    async def __call__(self, ctx: engine.NodeContext) -> Any:
        """Execute one node under its timeout and durable usage scope."""
        kind = self.kinds[ctx.node_id]
        path = self.workspace / ctx.run_id / ctx.node_id
        if ctx.item_id:
            path /= ctx.item_id
        path = model_io.prepare_workspace(path, ctx.run_inputs["issue_date"])
        timeout = ctx.params.get("timeout_seconds", 600)
        try:
            with usage.usage_scope(
                self.state.usage_sink(ctx.run_id),
                ctx.node_id + (":" + ctx.item_id if ctx.item_id else ""),
            ):
                async with asyncio.timeout(timeout):
                    return await self.execute(kind, ctx, path)
        except errors.EditorError as exc:
            # Safe, finite classifications only, never provider text.
            code = (
                exc.code
                if exc.code
                in {
                    "authentication",
                    "rate_limit",
                    "timeout",
                    "invalid_input",
                    "invalid_output",
                    "configuration",
                }
                else "handler_failed"
            )
            raise engine.NodeError(code) from None

    async def execute(
        self, kind: str, ctx: engine.NodeContext, path: pathlib.Path
    ) -> engine.NodeResult | types.Payload:
        """Dispatch an explicitly registered logical node type."""
        handlers = {
            "history": self._history,
            "api_feed": self._api_feed,
            "discovery": self._discover,
            "deduplicate": self._deduplicate,
            "selection": self._select,
        }
        handler = handlers.get(kind)
        if handler is None:
            raise engine.NodeError("configuration")
        return await handler(ctx, path)

    async def _history(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Read the frozen candidate and edition history.

        Runs frozen with threads also carry them and the recent candidate
        index; older runs keep showing the full records to their prompts.
        """
        inputs = ctx.run_inputs
        history = {
            "candidates": inputs["history"],
            "editions": inputs["editions"],
            "watchlist": [
                c for c in inputs["history"] if c.get("disposition") == "watch"
            ][:20],
        }
        if "threads" in inputs:
            history["threads"] = inputs["threads"]
            history["recent_candidates"] = inputs["recent_candidates"]
        return history

    async def _api_feed(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> engine.NodeResult | types.Payload:
        """Run the frozen researcher registry; no registry means no seeds.

        There is no code fallback list. Any failed source keeps the leads of
        the others and marks the node ``partial_failure``.
        """
        config = ctx.run_inputs.get("content_config")
        files = config.get("files", {}) if isinstance(config, dict) else {}
        text = files.get(researcher.REGISTRY_FILE)
        if not isinstance(text, str):
            return dataclasses.asdict(
                sources.MetadataResult([], ["registry:absent"])
            )
        try:
            registry = researcher.validate_registry(
                text, {item["id"] for item in ctx.run_inputs["instructions"]}
            )
        except researcher.RegistryError:
            return engine.NodeResult(
                dataclasses.asdict(
                    sources.MetadataResult([], ["registry:invalid"])
                ),
                error_code="partial_failure",
            )
        # Leave the node's own timeout room to persist what finished.
        budget = max(1, ctx.params.get("timeout_seconds", 600) - 15)
        metadata = await self.researcher.fetch(
            registry,
            ctx.run_inputs["issue_date"],
            history=ctx.run_inputs.get("history", []),
            budget_seconds=budget,
        )
        value = dataclasses.asdict(metadata)
        if researcher.failed(metadata):
            return engine.NodeResult(value, error_code="partial_failure")
        return value

    async def _discover(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Discover one direction with only the seeds routed to it."""
        date = ctx.run_inputs["issue_date"]
        direction = cast(types.Payload, ctx.item)
        history = self.one(
            ctx, "history", {"candidates": [], "editions": [], "watchlist": []}
        )
        feeds = [value for value in self.inputs(ctx, "api_feed") if value]
        seeds = [
            item
            for value in feeds
            for item in value["candidates"]
            # A frozen artifact from before the researcher has no notes; its
            # run offered every seed to every direction, so it still does.
            if "notes" not in value or item["direction"] == direction["id"]
        ]
        # Older artifacts have no notes; notes never leave this prompt.
        notes = {
            key: note
            for value in feeds
            for key, note in value.get("notes", {}).items()
        }
        discovered = await self.content.discover(
            instructions.Instruction(**direction),
            date,
            path,
            seeds=seeds,
            history=history["candidates"],
            watchlist=history["watchlist"],
            seed_notes=notes,
            threads=history.get("threads"),
            recent=history.get("recent_candidates"),
            **(
                {"content_config": ctx.run_inputs["content_config"]}
                if "content_config" in ctx.run_inputs
                else {}
            ),
        )
        return dataclasses.asdict(discovered)

    async def _deduplicate(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Merge discoveries in frozen order and apply the candidate budget."""
        date = ctx.run_inputs["issue_date"]
        history = self.one(
            ctx, "history", {"candidates": [], "editions": [], "watchlist": []}
        )
        limits = content.editorial_limits(ctx.run_inputs.get("content_config"))
        classifications: dict[str, types.Payload] = {}
        if limits is not None:
            for group in self.inputs(ctx, "discovery"):
                for result in group or []:
                    for identifier, classification in result.get(
                        "classifications", {}
                    ).items():
                        previous = classifications.get(identifier)
                        # Conflicting duplicate reports cannot upgrade an
                        # unknown/research candidate into a news slot.
                        if previous and previous["kind"] != "news":
                            continue
                        classifications[identifier] = classification
        groups = [
            result["candidates"]
            for group in self.inputs(ctx, "discovery")
            for result in group or []
        ]
        # Frozen map order breaks ties; retain each direction's local order.
        # Interleave before dedup/capping so later directions get pool space.
        candidates = [
            candidate
            for batch in itertools.zip_longest(*groups)
            for candidate in batch
            if candidate is not None
        ]
        feeds = [value for value in self.inputs(ctx, "api_feed") if value]
        leads = [item for value in feeds for item in value["candidates"]]
        if limits is not None:
            # Headline consensus enters as news ahead of the other leads;
            # an unopened copy discovery handed back gives way to it.
            picked = content.consensus_leads(
                leads,
                {
                    key: note
                    for value in feeds
                    for key, note in value.get("notes", {}).items()
                },
                candidates,
                classifications,
            )
            consensus = {lead["id"]: lead for lead, _ in picked}
            classifications.update(
                (lead["id"], basis) for lead, basis in picked
            )
            candidates = [
                c
                if c["provenance"] == "web_open"
                else consensus.get(c["id"], c)
                for c in candidates
            ]
            candidates.extend(consensus.values())
        candidates.extend(leads)
        removed: list[tuple[sources.Candidate, str]] = []
        candidates = sources.deduplicate_candidates(
            candidates,
            history["candidates"],
            limit=60
            if limits is not None
            else ctx.params.get("max_candidates", 30),
            dropped=removed,
        )
        if limits is not None:
            candidates, classifications = content.candidate_budget(
                candidates,
                classifications,
                maximum=ctx.params.get("max_candidates", 30),
                research_maximum=limits.max_research_candidates,
                dropped=removed,
            )
        # For the console's funnel: each candidate left out once, by its
        # first reason; a copy of a kept candidate is not a loss.
        kept = {c["id"] for c in candidates}
        dropped: dict[str, types.Payload] = {}
        for candidate, reason in removed:
            if candidate["id"] not in kept:
                dropped.setdefault(
                    candidate["id"],
                    {
                        "id": candidate["id"],
                        "direction": candidate["direction"],
                        "reason": reason,
                    },
                )
        normalized = [
            contracts.to_dict(
                contracts.parse_message(candidate, editorial_pb2.Candidate)
            )
            for candidate in candidates
        ]
        self.state.remember(normalized, date)
        # Frozen headline excerpts travel on only for the pool's events.
        excerpts = feed_excerpts.covered(
            [group for value in feeds for group in value.get("excerpts", [])],
            [
                url
                for candidate in normalized
                for url in (candidate["url"], *candidate["evidence_urls"])
            ],
        )
        return {
            "candidates": normalized,
            "coverage": self.coverage(ctx),
            "dropped": list(dropped.values()),
            **(
                {"classifications": classifications}
                if limits is not None
                else {}
            ),
            **(
                {
                    "threads": workflow_threads.annotate(
                        normalized, history["threads"]
                    )
                }
                if "threads" in history
                else {}
            ),
            **({"excerpts": excerpts} if excerpts else {}),
        }

    async def _select(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Select research tasks and record which candidates were chosen.

        Chosen candidates become researched; their outcome is followed through
        the publication record. The rest are only seen, so the watchlist keeps
        unfinished topics instead of every pooled candidate.
        """
        date = ctx.run_inputs["issue_date"]
        history = self.one(
            ctx, "history", {"candidates": [], "editions": [], "watchlist": []}
        )
        pool = self.one(ctx, "deduplicate")
        candidates = pool["candidates"]
        selected = await self.content.shortlist(
            candidates,
            date,
            path,
            history=history["candidates"],
            watchlist=history["watchlist"],
            max_tasks=ctx.params.get("max_tasks", 8),
            reader_profile=ctx.run_inputs.get("policy", {}).get(
                "reader-profile.md", ""
            ),
            threads=history.get("threads"),
            recent=history.get("recent_candidates"),
            candidate_threads=pool.get("threads"),
            **(
                {
                    "content_config": ctx.run_inputs["content_config"],
                    "classifications": pool.get("classifications", {}),
                }
                if "content_config" in ctx.run_inputs
                else {}
            ),
        )
        if not selected.research_tasks:
            raise engine.NodeError("no_findings")
        chosen = {
            ref
            for task in selected.research_tasks
            for ref in task["candidate_ids"]
        }
        self.state.mark(
            sorted(chosen),
            "researched",
            "入选本期调查；刊出与否见本期处理记录。",
            replacing=("seen", "watch"),
        )
        self.state.mark(
            [c["id"] for c in candidates if c["id"] not in chosen],
            "seen",
            "未入选；只有新的证据变化才重新选入。",
            replacing=("seen", "watch"),
        )
        return {**dataclasses.asdict(selected), "coverage": self.coverage(ctx)}
