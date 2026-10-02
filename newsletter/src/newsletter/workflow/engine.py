"""Execute logical nodes serially using code-supplied implementations.

No scheduler, dynamic imports, expressions, provider credentials, or publication
live here. Handlers may run bounded internal retrieval in parallel.
"""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
import dataclasses
import logging
from typing import Any

import newsletter.diagnostics as diagnostics
import newsletter.workflow.definition as newsletter_workflow_definition
import newsletter.workflow.repository as newsletter_workflow_repository
import newsletter.workflow.types as types

_LOGGER = logging.getLogger(__name__)


@dataclasses.dataclass(frozen=True)
class NodeContext:
    """Carry the frozen inputs and dependency receipts for one invocation."""

    run_id: str
    node_id: str
    item_id: str
    params: dict[str, Any]
    inputs: dict[str, Any]
    run_inputs: dict[str, Any]
    dependency_states: dict[str, Any] = dataclasses.field(default_factory=dict)
    item: dict[str, Any] | None = None
    context: Any = None


@dataclasses.dataclass(frozen=True)
class NodeResult:
    """Represent an explicit successful or skipped node result."""

    value: Any = None
    state: str = "succeeded"
    error_code: str = ""

    @classmethod
    def skipped(
        cls, value: Any = None, code: str = "no_findings"
    ) -> "NodeResult":
        """Create an explicit skipped result with a finite reason code."""
        return cls(value, "skipped", code)


class NodeError(RuntimeError):
    """Classify a node failure without retaining upstream error text."""

    def __init__(
        self, code: str = "handler_failed", *, ambiguous: bool = False
    ) -> None:
        self.code = (
            code
            if code in newsletter_workflow_repository.ERROR_CODES
            else "handler_failed"
        )
        self.ambiguous = ambiguous
        super().__init__("Workflow node failed: " + self.code)


NodeHandler = Callable[[NodeContext], Awaitable[NodeResult | Any]]


@dataclasses.dataclass
class WorkflowEngine:
    """Execute explicitly supplied node handlers against durable receipts."""

    repository: newsletter_workflow_repository.WorkflowRepository
    handlers: Mapping[str, NodeHandler]
    context: Any = None
    _lock: asyncio.Lock = dataclasses.field(
        default_factory=asyncio.Lock, init=False, repr=False
    )

    def __post_init__(self) -> None:
        if set(
            self.handlers
        ) - newsletter_workflow_definition.NODE_TYPES or any(
            not callable(handler) for handler in self.handlers.values()
        ):
            raise NodeError("configuration")

    async def run(self, run_id: str) -> types.WorkflowRun:
        """Advance a run until no currently eligible node remains."""
        while await self.run_step(run_id):
            pass
        return self.repository.get(run_id)

    async def step(self, run_id: str) -> bool:
        """Advance one eligible node or map expansion."""
        return await self.run_step(run_id)

    async def run_step(self, run_id: str) -> bool:
        """Advance one expansion or persisted attempt without replaying work."""
        async with self._lock:
            run = self.repository.get(run_id)
            if run["state"] not in {"queued", "running"}:
                return False
            snapshot = self.repository.snapshot(run_id)
            definition = newsletter_workflow_definition.parse_definition(
                snapshot["definition"]
            )
            for node in definition.nodes:
                state = run["nodes"][node.id]
                if state["state"] not in {"pending", "running"}:
                    continue
                if any(
                    run["nodes"][dependency]["state"]
                    not in newsletter_workflow_repository.SUCCESS_STATES
                    for dependency in node.needs
                ):
                    continue
                inputs = {
                    dependency: self.repository.output(run_id, dependency)
                    for dependency in node.needs
                }
                if node.map and not state["map_expanded"]:
                    try:
                        items = self._items(node, inputs, snapshot["inputs"])
                        self.repository.expand_map(run_id, node.id, items)
                    except (
                        NodeError,
                        newsletter_workflow_repository.WorkflowError,
                    ):
                        attempt = self.repository.claim(
                            run_id, node.id, "", {"invalid_map": True}
                        )
                        if attempt:
                            self.repository.finish(
                                attempt, "failed", error_code="invalid_input"
                            )
                        return attempt is not None
                    return True
                item = None
                if node.map:
                    item = next(
                        (
                            entry
                            for entry in state["items"]
                            if entry["state"] == "pending"
                        ),
                        None,
                    )
                    if item is None:
                        continue
                elif state["state"] != "pending":
                    continue
                context = NodeContext(
                    run_id=run_id,
                    node_id=node.id,
                    item_id=item["id"] if item else "",
                    params=node.params,
                    inputs=inputs,
                    run_inputs=snapshot["inputs"],
                    dependency_states={
                        dependency: run["nodes"][dependency]
                        for dependency in node.needs
                    },
                    item=item["value"] if item else None,
                    context=self.context,
                )
                attempt = self.repository.claim(
                    run_id,
                    node.id,
                    context.item_id,
                    {
                        "definition_hash": definition.digest,
                        "params": context.params,
                        "inputs": context.inputs,
                        "run_inputs": context.run_inputs,
                        "item": context.item,
                    },
                )
                if attempt is None:
                    continue
                await self._execute(node, context, attempt)
                return True
            return False

    @staticmethod
    def _items(
        node: newsletter_workflow_definition.NodeDefinition,
        inputs: dict[str, Any],
        run_inputs: dict[str, Any],
    ) -> Any:
        if node.map is None:
            raise NodeError("configuration")
        parts = node.map.source.split(".")
        value: Any = run_inputs if parts[0] == "run" else inputs.get(parts[0])
        for key in parts[1:]:
            if not isinstance(value, dict) or key not in value:
                raise NodeError("invalid_input")
            value = value[key]
        return value

    async def _execute(
        self,
        node: newsletter_workflow_definition.NodeDefinition,
        context: NodeContext,
        attempt: str,
    ) -> None:
        try:
            handler = self.handlers.get(node.type)
            if handler is None:
                raise NodeError("configuration")
            output = await handler(context)
            result = (
                output if isinstance(output, NodeResult) else NodeResult(output)
            )
            if (
                result.state
                not in newsletter_workflow_repository.SUCCESS_STATES
                or (
                    result.error_code
                    and result.error_code
                    not in newsletter_workflow_repository.ERROR_CODES
                )
            ):
                raise NodeError("invalid_output")
            self.repository.finish(
                attempt, result.state, result.value, result.error_code
            )
        except asyncio.CancelledError:
            self.repository.finish(attempt, "unknown", error_code="interrupted")
            raise
        except TimeoutError:
            self.repository.finish(attempt, "unknown", error_code="timeout")
        except NodeError as error:
            self.repository.finish(
                attempt,
                "unknown" if error.ambiguous else "failed",
                error_code=error.code,
            )
        except Exception as exc:  # noqa: BLE001
            # Isolate a handler failure; persist only finite safe diagnostics.
            diagnostics.record_failure(
                _LOGGER,
                phase="workflow_node",
                error=exc,
                reference=context.run_id,
            )
            self.repository.finish(
                attempt, "failed", error_code="handler_failed"
            )
