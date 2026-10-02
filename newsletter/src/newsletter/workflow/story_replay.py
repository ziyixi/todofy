"""Audit one story-writer restart after a shared startup failure.

The terminal parent is immutable. Its successful upstream artifacts are read as
untrusted research inputs by local child attempts, never reissued to providers.
No source approval, publication, Notion operation or delivery can be replayed.
"""

from __future__ import annotations

import copy
import json

import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.errors as errors
import newsletter.store as newsletter_store
import newsletter.types as types
from newsletter.workflow import types as workflow_types
import newsletter.workflow.content as content
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.engine as engine
import newsletter.workflow.publication as publication
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.state as state
import newsletter.workflow.story_recipe as story_recipe
import newsletter.workflow.story_replay_repository as story_replay_repository

REUSABLE_TYPES = frozenset(
    {
        "history",
        "api_feed",
        "discovery",
        "deduplicate",
        "selection",
        "story_plan",
    }
)


def _conflict() -> newsletter_store.StoreError:
    return newsletter_store.StoreError(
        "conflict",
        "Story restart requires intact, eligible frozen source receipts",
    )


class StoryReplay:
    """Audit one child restart without replaying source publication effects."""

    def __init__(self, store: newsletter_store.Store) -> None:
        self.store = store
        self.runs = repository.RunRepository(store)
        self.workflows = newsletter_workflow_repository.WorkflowRepository(
            store
        )
        self.publications = publication.PublicationRepository(store)
        self.receipts = story_replay_repository.StoryReplayRepository(store)

    def start(self, parent_id: str, request: types.Payload) -> types.Payload:
        """Create at most one child without resetting repeated requests."""
        contracts.validate_request(
            contracts.parse_message(
                {"id": parent_id}, editorial_pb2.GetRunRequest
            )
        )
        contracts.validate_request(
            contracts.parse_message(request, editorial_pb2.StartRunRequest)
        )
        with self.store.transaction():
            row = self.receipts.parent_record(parent_id)
            if row is not None:
                receipt = self._receipt(row)
                if receipt["request"] != request:
                    raise _conflict()
                return self.runs.get(receipt["child_run_id"])
            if self.runs.existing(
                request
            ) is not None or self.receipts.is_child(parent_id):
                raise _conflict()
            snapshot, manifest = self._source(parent_id)
            if request["issue_date"] != snapshot["inputs"]["issue_date"]:
                raise _conflict()
            child_snapshot = copy.deepcopy(snapshot)
            child_snapshot["inputs"].update(
                started_at=newsletter_store.now(), story_replay=manifest
            )
            instructions = [
                newsletter_collection_instructions.Instruction(**item)
                for item in snapshot["inputs"]["instructions"]
            ]
            child = self.runs.start_in_transaction(
                request, instructions, workflow_snapshot=child_snapshot
            )
            receipt = {
                "parent_run_id": parent_id,
                "child_run_id": child["id"],
                "request": copy.deepcopy(request),
                "snapshot_hash": contracts.content_hash(child_snapshot),
                "manifest": manifest,
                "created_at": newsletter_store.now(),
            }
            self.receipts.save_in_transaction(receipt)
            return child

    def _receipt(
        self, row: story_replay_repository.ReplayRecord
    ) -> types.Payload:
        receipt: object = json.loads(row["body"])
        if not isinstance(receipt, dict):
            raise _conflict()
        snapshot = self.runs.workflow_snapshot(row["child_run_id"])
        if (
            contracts.content_hash(receipt) != row["digest"]
            or receipt["parent_run_id"] != row["parent_run_id"]
            or receipt["child_run_id"] != row["child_run_id"]
            or receipt["request"]["request_key"] != row["request_key"]
            or snapshot is None
            or contracts.content_hash(snapshot) != receipt["snapshot_hash"]
            or snapshot["inputs"].get("story_replay") != receipt["manifest"]
        ):
            raise _conflict()
        return receipt

    def _source(self, parent_id: str) -> tuple[types.Payload, types.Payload]:
        """Check source eligibility and hashes without changing the parent."""
        try:
            return self._validated_source(parent_id)
        except (
            KeyError,
            TypeError,
            ValueError,
            errors.EditorError,
            newsletter_workflow_repository.WorkflowError,
        ):
            raise _conflict() from None

    def _validated_source(
        self, parent_id: str
    ) -> tuple[types.Payload, types.Payload]:
        parent = self.runs.get(parent_id)
        snapshot = self.runs.workflow_snapshot(parent_id)
        graph = self.workflows.get(parent_id)
        frozen = self.workflows.snapshot(parent_id)
        definition = newsletter_workflow_definition.parse_definition(
            frozen["definition"]
        )
        story_recipe.validate_story_recipe(definition)
        if (
            parent["state"] != "blocked"
            or parent["error_code"] != "no_publishable_content"
            or parent["edition_id"]
            or graph["state"] not in {"failed", "succeeded"}
            or snapshot
            != {"definition": frozen["definition"], "inputs": frozen["inputs"]}
            or definition.digest != frozen["definition_hash"]
            or contracts.content_hash(frozen["inputs"]) != frozen["inputs_hash"]
            or graph["definition_hash"] != frozen["definition_hash"]
            or graph["inputs_hash"] != frozen["inputs_hash"]
            or "story_replay" in frozen["inputs"]
            or parent["issue_date"] != frozen["inputs"]["issue_date"]
            or self.publications.get_publication(parent_id) is not None
            or self.workflows.has_edition_binding(parent_id)
        ):
            raise _conflict()
        instructions = self.runs.instruction_snapshot(parent_id)
        if (
            instructions != frozen["inputs"]["instructions"]
            or contracts.content_hash(instructions)
            != parent["instructions_hash"]
            or any(
                contracts.content_hash(item["text"]) != item["digest"]
                for item in instructions
            )
        ):
            raise _conflict()

        roles = {node.type: node for node in definition.nodes}
        indexed, manifest_artifacts, attempts = self._validated_artifacts(
            parent_id, definition, graph, frozen
        )
        candidates = indexed[(roles["deduplicate"].id, "")]["value"][
            "candidates"
        ]
        for candidate in candidates:
            contracts.parse_message(candidate, editorial_pb2.Candidate)
        selected = indexed[(roles["selection"].id, "")]["value"]
        tasks = content.parse_plan(
            contracts.canonical_json(
                {
                    "research_tasks": selected["research_tasks"],
                    "note": selected["note"],
                }
            ),
            {item["id"] for item in candidates},
            {item["url"] for item in candidates},
            roles["selection"].params.get("max_tasks", 8),
        ).research_tasks
        plan = indexed[(roles["story_plan"].id, "")]["value"]
        deep_limit = roles["story_plan"].params.get("max_deep", 4)
        configuration = frozen["inputs"].get("content_config")
        if configuration is not None:
            deep_limit = min(deep_limit, configuration["editorial"]["max_deep"])
        if (
            not tasks
            or self.publications.plan(parent_id) != tasks
            or plan["brief_tasks"] != tasks
            or plan["deep_tasks"] != tasks[:deep_limit]
        ):
            raise _conflict()
        results = self.publications.results(parent_id)
        for value in results:
            publication.validate_result(value)
            if (
                value["content"] is not None
                or value["signal"] is not None
                or value["assessments"]
                or value.get("withdrawals")
                or value["packets"]
                or value["reason"] != "editor_unavailable"
                or value["issues"]
                != [
                    {
                        "round": "service",
                        "component": "body",
                        "claim": "",
                        "reason": "writer:unavailable",
                        "evidence": [],
                        "action": "research",
                    }
                ]
            ):
                raise _conflict()
        story_ids = {roles[kind].id for kind in ("story_brief", "story_deep")}
        story_attempts = [
            attempt for attempt in attempts if attempt["node_id"] in story_ids
        ]
        configuration = (
            len(story_attempts) == 1
            and story_attempts[0]["state"] == "failed"
            and story_attempts[0]["node_id"] == roles["story_brief"].id
            and story_attempts[0]["error_code"] == "configuration"
            and not results
        )
        unavailable = (
            bool(story_attempts)
            and all(
                attempt["state"] == "succeeded" for attempt in story_attempts
            )
            and {(value["story_id"], value["mode"]) for value in results}
            == {(task["id"], "brief") for task in tasks}
            | {(task["id"], "deep") for task in plan["deep_tasks"]}
            and len(results) == len(story_attempts)
        )
        for attempt in story_attempts:
            if attempt["state"] == "succeeded":
                artifact = indexed[(attempt["node_id"], attempt["item_id"])]
                digest = contracts.content_hash(artifact["value"])
                if (
                    artifact["content_hash"] != digest
                    or artifact["id"] != attempt["artifact_id"]
                    or artifact["id"]
                    != contracts.content_hash(
                        {
                            "run": parent_id,
                            "node": attempt["node_id"],
                            "item": attempt["item_id"],
                            "hash": digest,
                        }
                    )
                    or artifact["value"] not in results
                ):
                    raise _conflict()
        # Missing token reports are not zero consumption. Retain the original
        # failed invocation records in lineage totals, including partial flags.
        # This bridge only accepts a single failed startup turn per story.
        # A timeout, account limit or actual editorial rejection is not
        # eligible.
        usage = [
            value
            for value in state.usage_records(self.store, parent_id)
            if value["stage"].split(":")[0] in story_ids
        ]
        stages = {
            attempt["node_id"] + ":" + attempt["item_id"]
            for attempt in story_attempts
        }
        if (
            not (configuration or unavailable)
            or any(
                value["stage"] not in stages
                or value["status"] != "failed"
                or value["usage"] is not None
                or value["usage_events"] != 0
                or value["turns_with_usage"] != 0
                or value["turns_started"] != 1
                or value["turns_completed"] not in {0, 1}
                or (unavailable and value["turns_completed"] != 1)
                for value in usage
            )
            or len({value["stage"] for value in usage}) != len(usage)
            or (unavailable and {value["stage"] for value in usage} != stages)
        ):
            raise _conflict()
        if snapshot is None:
            raise _conflict()
        return snapshot, {
            "parent_run_id": parent_id,
            "definition_hash": frozen["definition_hash"],
            "inputs_hash": frozen["inputs_hash"],
            "tasks_hash": contracts.content_hash(tasks),
            "failure_hash": contracts.content_hash(
                {"attempts": story_attempts, "results": results}
            ),
            "artifacts": manifest_artifacts,
            "reason": "shared_writer_configuration"
            if configuration
            else "writer_startup_unavailable",
        }

    def _validated_artifacts(
        self,
        parent_id: str,
        definition: newsletter_workflow_definition.WorkflowDefinition,
        graph: workflow_types.WorkflowRun,
        frozen: workflow_types.WorkflowSnapshot,
    ) -> tuple[
        dict[tuple[str, str], types.Payload],
        list[types.Payload],
        list[types.Payload],
    ]:
        upstream = {
            node.id: node
            for node in definition.nodes
            if node.type in REUSABLE_TYPES
        }
        artifacts = self.workflows.artifacts(parent_id)
        indexed = {
            (item["node_id"], item["item_id"]): item for item in artifacts
        }
        attempts = self.workflows.attempts(parent_id)
        attempt_map = {
            (item["node_id"], item["item_id"]): item for item in attempts
        }
        manifest_artifacts = []
        for node_id in sorted(upstream):
            node = upstream[node_id]
            state = graph["nodes"][node_id]
            if state["state"] != "succeeded" or state["degraded"]:
                raise _conflict()
            dependencies = {
                key: indexed[(key, "")]["value"] for key in node.needs
            }
            if node.map is not None:
                parts = node.map.source.split(".")
                items = (
                    frozen["inputs"]
                    if parts[0] == "run"
                    else dependencies[parts[0]]
                )
                for part in parts[1:]:
                    items = items[part]
                if (
                    not state["map_expanded"]
                    or state["map_hash"] != contracts.content_hash(items)
                    or [item["value"] for item in state["items"]] != items
                    or [item["id"] for item in state["items"]]
                    != [item["id"] for item in items]
                ):
                    raise _conflict()
            elif state["map_expanded"] or state["items"]:
                raise _conflict()
            targets = [("", state["state"], state["artifact_id"], None)] + [
                (item["id"], item["state"], item["artifact_id"], item["value"])
                for item in state["items"]
            ]
            for item_id, target_state, artifact_id, item_value in targets:
                artifact = indexed[(node_id, item_id)]
                digest = contracts.content_hash(artifact["value"])
                identifier = contracts.content_hash(
                    {
                        "run": parent_id,
                        "node": node_id,
                        "item": item_id,
                        "hash": digest,
                    }
                )
                if (
                    target_state != "succeeded"
                    or artifact_id != artifact["id"]
                    or artifact["id"] != identifier
                    or artifact["content_hash"] != digest
                ):
                    raise _conflict()
                if item_id or not state["map_expanded"]:
                    attempt = attempt_map[(node_id, item_id)]
                    if (
                        attempt["state"] != "succeeded"
                        or attempt["artifact_id"] != identifier
                        or attempt["input_hash"]
                        != contracts.content_hash(
                            {
                                "definition_hash": definition.digest,
                                "params": node.params,
                                "inputs": dependencies,
                                "run_inputs": frozen["inputs"],
                                "item": item_value if item_id else None,
                            }
                        )
                    ):
                        raise _conflict()
                manifest_artifacts.append(
                    {
                        "node_id": node_id,
                        "item_id": item_id,
                        "artifact_id": identifier,
                        "content_hash": digest,
                    }
                )
        return indexed, manifest_artifacts, attempts

    def replay(self, ctx: engine.NodeContext) -> types.Payload:
        """Verify and import one exact upstream result in a local attempt."""
        # Keep the receipt, source audit, and copied artifact in one locked
        # observation even though each repository also protects its own reads.
        with self.store.lock:
            row = self.receipts.child_record(ctx.run_id)
            if row is None:
                raise _conflict()
            receipt = self._receipt(row)
            snapshot, manifest = self._source(receipt["parent_run_id"])
            child_snapshot = self.runs.workflow_snapshot(ctx.run_id)
            if (
                manifest != receipt["manifest"]
                or child_snapshot is None
                or ctx.run_inputs != child_snapshot["inputs"]
                or ctx.run_inputs.get("story_replay") != manifest
            ):
                raise _conflict()
            definition = newsletter_workflow_definition.parse_definition(
                snapshot["definition"]
            )
            node = next(
                node for node in definition.nodes if node.id == ctx.node_id
            )
            if node.type not in REUSABLE_TYPES:
                raise _conflict()
            source = next(
                item
                for item in self.workflows.artifacts(
                    receipt["parent_run_id"], ctx.node_id
                )
                if item["item_id"] == ctx.item_id
            )
            value: object = copy.deepcopy(source["value"])
            if not isinstance(value, dict):
                raise _conflict()
        if node.type == "story_plan":
            self.publications.save_plan(
                ctx.run_id, ctx.run_inputs["issue_date"], value["brief_tasks"]
            )
        return value
