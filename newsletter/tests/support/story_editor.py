"""Shared offline story editor builders and fakes."""

from __future__ import annotations

from collections.abc import Callable
import copy
import dataclasses
import json
import pathlib
from typing import Literal, TypedDict, Unpack

import pytest

import newsletter.contracts as contracts
import newsletter.editor as newsletter_editor
import newsletter.types as types
import newsletter.workflow.components as components
import newsletter.workflow.story_editor as story_editor

URL = "https://example.com/research"

SECOND_URL = "https://example.com/publication"


def story(
    text: str = "离线虚构事件发生；不是真实报道。",
    *,
    reading: bool = False,
    chart: bool = False,
) -> types.Payload:
    """Build a synthetic story with separately testable optional components."""
    value: types.Payload = {
        "story_id": "story-a",
        "title": "虚构事件的已知事实",
        "kind": "feature",
        "paragraphs": [{"text": text, "citations": ["packet/source"]}],
        "limitations": "仅离线fixture，不能真实发送。",
    }
    if reading:
        value["recommended_reading"] = {
            "citation": "packet/source",
            "reason": "离线方法、结果及边界。",
            "supporting_citations": ["packet/publication"],
        }
    if chart:
        value["chart"] = {
            "kind": "bar",
            "question": "虚构两组如何不同？",
            "metric": "虚构观测",
            "unit": "fixture",
            "period": "无真实时间范围",
            "caption": "不是研究结果",
            "alt_text": "虚构对比",
            "limitations": "仅测试",
            "points": [
                {
                    "label": "A",
                    "decimal_value": "1",
                    "citations": ["packet/source"],
                },
                {
                    "label": "B",
                    "decimal_value": "2",
                    "citations": ["packet/source"],
                },
            ],
        }
    return value


def writer(
    content: types.Payload | None = None,
    signal: types.Payload | None = None,
    supplements: list[types.Payload] | None = None,
) -> types.Payload:
    """Build a writer response without fabricating reviewer approval."""
    return {
        "content": content,
        "signal": signal,
        "supplemental_packets": supplements or [],
    }


def review(
    *,
    body: str = "approved",
    signal: str = "not_present",
    reading: str = "not_present",
    chart: str = "not_present",
    issues: list[types.Payload] | None = None,
    prior_withdrawal: types.Payload | None = None,
) -> types.Payload:
    """Build component assessments, including invalid test statuses."""
    statuses = {
        "body": body,
        "signal": signal,
        "reading": reading,
        "chart": chart,
    }
    return {
        "assessments": [
            {
                "component": name,
                "status": statuses[name],
                "findings": ["fixture finding"]
                if statuses[name] == "blocked"
                else [],
            }
            for name in components.COMPONENTS
        ],
        "issues": issues or [],
        "prior_withdrawal": prior_withdrawal,
    }


type StoryReply = tuple[types.Payload | str, set[str], bool]


class EditorCall(TypedDict):
    """Captured arguments passed to a story writer or independent reviewer."""

    prompt: types.Payload
    schema: types.Payload
    instructions: str
    path: pathlib.Path
    approval_sources: newsletter_editor.ApprovalSources | None


class StoryOptions(TypedDict, total=False):
    """Optional overrides for one synthetic StoryEditor preparation."""

    task: types.Payload
    candidates: list[types.Payload]
    packets: list[types.Payload]
    issue_date: str
    policy: types.Payload
    workspace: pathlib.Path
    mode: Literal["brief", "deep"]
    prior: types.Payload | None
    is_fixture: bool
    on_checkpoint: Callable[[types.Payload], None] | None


@dataclasses.dataclass
class StoryRig:
    """Typed editor harness with explicit response and checkpoint history."""

    editor: story_editor.StoryEditor
    packet: types.Payload
    workspace: pathlib.Path
    replies: list[StoryReply | BaseException] = dataclasses.field(
        default_factory=list
    )
    calls: list[EditorCall] = dataclasses.field(default_factory=list)
    checkpoints: list[types.Payload] = dataclasses.field(default_factory=list)

    async def run(self, **overrides: Unpack[StoryOptions]) -> types.Payload:
        """Prepare one story with isolated defaults and queued responses."""
        policy = {
            "editorial.md": "Fixture policy",
            "reader-profile.md": "Fixture reader",
        }
        return await self.editor.prepare(
            task=overrides.get(
                "task", {"id": "story-a", "question": "虚构事件"}
            ),
            candidates=overrides.get("candidates", []),
            packets=overrides.get("packets", [copy.deepcopy(self.packet)]),
            issue_date=overrides.get("issue_date", "2026-09-06"),
            policy=overrides.get("policy", policy),
            workspace=overrides.get("workspace", self.workspace),
            mode=overrides.get("mode", "brief"),
            prior=overrides.get("prior"),
            is_fixture=overrides.get("is_fixture", True),
            on_checkpoint=overrides.get(
                "on_checkpoint", self.checkpoints.append
            ),
        )


@pytest.fixture
def rig(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> StoryRig:
    """Run the real story editor with bounded offline responses and evidence."""
    packet_body = {
        "title": "离线材料",
        "body": "虚构事件和观测，不得发送。",
        "tags": ["fixture"],
        "sources": [
            {
                "id": name,
                "title": "虚构来源",
                "url": url,
                "excerpt": "fixture excerpt",
                "access_scope": "full_text",
                "published_at": "",
            }
            for name, url in (("source", URL), ("publication", SECOND_URL))
        ],
    }
    packet = {
        "id": "packet",
        "content": packet_body,
        "workflow_id": "fixture",
        "producer_id": "fixture",
        "content_hash": contracts.content_hash(packet_body),
        "created_at": "2026-09-06T00:00:00Z",
        "is_fixture": True,
    }
    state = StoryRig(
        editor=story_editor.StoryEditor(
            newsletter_editor.CodexEditor(tmp_path / "unused-auth")
        ),
        packet=packet,
        workspace=tmp_path / "job",
    )

    async def execute(
        editor: newsletter_editor.CodexEditor,
        prompt: str,
        schema: types.Payload,
        instructions: str,
        workspace: pathlib.Path,
        *,
        approval_sources: newsletter_editor.ApprovalSources | None = None,
    ) -> tuple[str, set[str], bool]:
        state.calls.append(
            {
                "prompt": json.loads(prompt),
                "schema": schema,
                "instructions": instructions,
                "path": workspace,
                "approval_sources": approval_sources,
            }
        )
        assert state.replies, "No unbounded retry or unexpected model call"
        response = state.replies.pop(0)
        if isinstance(response, BaseException):
            raise response
        value, opened, searched = response
        return (
            value if isinstance(value, str) else json.dumps(value),
            opened,
            searched,
        )

    monkeypatch.setattr(newsletter_editor.CodexEditor, "execute", execute)
    return state


def reply(
    value: types.Payload | str,
    *,
    opened: set[str] | None = None,
    searched: bool = True,
) -> StoryReply:
    """Pair one model response with its explicit research-provenance facts."""
    return value, {URL, SECOND_URL} if opened is None else opened, searched
