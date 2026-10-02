"""Shared offline news first policy builders and fakes."""

from __future__ import annotations

import newsletter.types as types
import tests.support.workflow_content as workflow_content


def news(number: int = 1, **changes: object) -> types.Payload:
    """Build a synthetic real-world news candidate."""
    result = workflow_content.candidate(
        id=f"news-{number}",
        direction="03-world",
        doi="",
        version="",
        title=f"A concrete real-world development {number}",
        url=f"https://example.org/developments/{number}",
    )
    result.update(changes)
    return result


def paper(number: int = 1, **changes: object) -> types.Payload:
    """Build a synthetic paper candidate."""
    return workflow_content.candidate(
        id=f"paper-{number}",
        title=f"Synthetic research candidate {number}",
        url=f"https://arxiv.org/abs/2609.{number:05d}",
        **changes,
    )
