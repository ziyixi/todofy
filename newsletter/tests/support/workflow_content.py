"""Shared offline workflow content builders and fakes."""

from __future__ import annotations

import json
import pathlib

import newsletter.types as types
import newsletter.workflow.schema as newsletter_workflow_schema

DAY = "2026-09-06"

URL = "https://arxiv.org/abs/2609.00001v2"


def candidate(**changes: object) -> types.Payload:
    """Build candidate JSON, including deliberate invalid-field overrides."""
    result: types.Payload = {
        "id": "candidate-1",
        "direction": "01-ai-ml",
        "title": "Synthetic research candidate",
        "url": URL,
        "doi": "",
        "version": "v2",
        "event_key": "",
        "published_at": DAY,
        "summary": (
            "Synthetic research question; its claims require "
            "independent primary reading."
        ),
        "why_now": (
            "A new controlled experiment changes the previous reported "
            "result and merits verification."
        ),
        "access_scope": "abstract",
        "provenance": "web_open",
    }
    result.update(changes)
    return result


def discovered(*items: types.Payload) -> str:
    """Serialize candidate JSON as a synthetic discovery-model response."""
    return json.dumps(
        {
            "note": "Synthetic public discovery",
            "candidates": [
                {
                    key: item.get(key, [] if key == "evidence_urls" else "")
                    for key in newsletter_workflow_schema.CANDIDATE_FIELDS
                }
                for item in items
            ],
        }
    )


def task(**changes: object) -> types.Payload:
    """Build a synthetic research-task payload with optional overrides."""
    return {
        "id": "research-1",
        "candidate_ids": ["candidate-1"],
        "question": "Check methods and controls",
        "why": "A decision needs evidence",
        "priority": 1,
        "evidence_context": "The abstract omits the matched-data comparison.",
        "source_urls": [URL],
        **changes,
    }


def planned(*items: types.Payload) -> str:
    """Serialize tasks as a synthetic planner response."""
    return json.dumps(
        {
            "research_tasks": list(items),
            "note": "Synthetic selection, not verification",
        }
    )


class Engine:
    """Return queued model responses and capture complete invocation inputs."""

    def __init__(self, *outputs: tuple[str, set[str], bool]) -> None:
        self.outputs = list(outputs)
        self.calls: list[
            tuple[types.Payload, types.Payload, str, pathlib.Path]
        ] = []

    async def execute(
        self,
        prompt: str,
        schema: types.Payload,
        instructions: str,
        workspace: pathlib.Path,
    ) -> tuple[str, set[str], bool]:
        """Capture an invocation and return the next queued model response."""
        self.calls.append((json.loads(prompt), schema, instructions, workspace))
        return self.outputs.pop(0)
