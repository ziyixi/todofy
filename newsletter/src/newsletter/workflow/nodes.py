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
import newsletter.workflow.sources as sources
import newsletter.workflow.state as newsletter_workflow_state


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
        editor: newsletter_editor.CodexEditor,
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
        self.feed = sources.PublicMetadataFeed()
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
        """Read the frozen candidate and edition history."""
        return {
            "candidates": ctx.run_inputs["history"],
            "editions": ctx.run_inputs["editions"],
            "watchlist": [
                c
                for c in ctx.run_inputs["history"]
                if c.get("disposition") == "watch"
            ][:20],
        }

    async def _api_feed(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Fetch the configured public metadata feed."""
        date = ctx.run_inputs["issue_date"]
        metadata = await self.feed.fetch(date)
        return dataclasses.asdict(metadata)

    async def _discover(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Discover one direction against the frozen history."""
        date = ctx.run_inputs["issue_date"]
        history = self.one(
            ctx, "history", {"candidates": [], "editions": [], "watchlist": []}
        )
        seeds = [
            item
            for value in self.inputs(ctx, "api_feed")
            if value
            for item in value["candidates"]
        ]
        discovered = await self.content.discover(
            instructions.Instruction(**cast(types.Payload, ctx.item)),
            date,
            path,
            seeds=seeds,
            history=history["candidates"],
            watchlist=history["watchlist"],
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
        candidates.extend(
            item
            for value in self.inputs(ctx, "api_feed")
            if value
            for item in value["candidates"]
        )
        candidates = sources.deduplicate_candidates(
            candidates,
            history["candidates"],
            limit=60
            if limits is not None
            else ctx.params.get("max_candidates", 30),
        )
        if limits is not None:
            candidates, classifications = content.candidate_budget(
                candidates,
                classifications,
                maximum=ctx.params.get("max_candidates", 30),
                research_maximum=limits.max_research_candidates,
            )
        normalized = [
            contracts.to_dict(
                contracts.parse_message(candidate, editorial_pb2.Candidate)
            )
            for candidate in candidates
        ]
        self.state.remember(normalized, date)
        return {
            "candidates": normalized,
            "coverage": self.coverage(ctx),
            **(
                {"classifications": classifications}
                if limits is not None
                else {}
            ),
        }

    async def _select(
        self, ctx: engine.NodeContext, path: pathlib.Path
    ) -> types.Payload:
        """Select research tasks and persist their watch disposition."""
        date = ctx.run_inputs["issue_date"]
        history = self.one(
            ctx, "history", {"candidates": [], "editions": [], "watchlist": []}
        )
        candidates = self.one(ctx, "deduplicate")["candidates"]
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
            **(
                {
                    "content_config": ctx.run_inputs["content_config"],
                    "classifications": self.one(ctx, "deduplicate").get(
                        "classifications", {}
                    ),
                }
                if "content_config" in ctx.run_inputs
                else {}
            ),
        )
        if not selected.research_tasks:
            raise engine.NodeError("no_findings")
        self.state.mark(
            [c["id"] for c in candidates],
            "watch",
            "未优先深入；只有新的证据变化才重新选入。",
        )
        return {**dataclasses.asdict(selected), "coverage": self.coverage(ctx)}
