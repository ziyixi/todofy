"""Typed views of code-owned ledgers and review receipts.

Protobuf continues to own external content. These views do not serialize values
or replace runtime validation at JSON and storage boundaries.
"""

from typing import Literal, NotRequired, TypedDict

import newsletter.types as types

RunState = Literal["queued", "running", "succeeded", "failed", "unknown"]
NodeState = Literal[
    "pending", "running", "succeeded", "skipped", "failed", "unknown"
]
ComponentName = Literal["body", "reading", "chart", "signal"]
AssessmentStatus = Literal["approved", "blocked", "not_present"]


class WorkflowItem(TypedDict):
    """One frozen map input and its durable execution state."""

    id: str
    value: types.Payload
    state: NodeState
    artifact_id: str
    error_code: str


class WorkflowNode(TypedDict):
    """One logical node, including the ordered receipts of mapped children."""

    state: NodeState
    artifact_id: str
    error_code: str
    map_expanded: bool
    map_hash: str
    items: list[WorkflowItem]
    degraded: bool
    failure_state: NotRequired[NodeState]


class WorkflowRun(TypedDict):
    """A stored workflow's fixed control metadata."""

    id: str
    state: RunState
    definition_hash: str
    inputs_hash: str
    created_at: str
    updated_at: str
    nodes: dict[str, WorkflowNode]


class WorkflowSnapshot(TypedDict):
    """The exact graph and input values frozen before execution."""

    definition: types.Payload
    inputs: types.Payload
    definition_hash: str
    inputs_hash: str


class Assessment(TypedDict):
    """An observed, content-bound approval from an isolated reviewer job."""

    round: str
    component: str
    status: AssessmentStatus
    findings: list[str]
    content_hash: str
    searched: bool
    opened: bool
    opened_urls: list[str]
    writer_job_id: str
    reviewer_job_id: str


class ReviewIssue(TypedDict):
    """A factual issue or code-owned evidence diagnostic."""

    round: str
    component: str
    claim: str
    reason: str
    evidence: list[str]
    action: str


class ReviewReceipt(TypedDict):
    """Normalized review output with independently bound withdrawals."""

    assessments: list[Assessment]
    issues: list[ReviewIssue]
    withdrawals: list[types.Payload]
