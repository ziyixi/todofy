"""Shared offline notion content builders and fakes."""

from __future__ import annotations

import base64
import copy

import newsletter.contracts as contracts
import newsletter.notion_content as notion_content
import newsletter.types as types
import tests.support.rendering as rendering

DAY = "2026-09-07"

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAA"
    "AAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)


def candidate(**changes: object) -> types.Payload:
    """Build synthetic material metadata with boundary-test overrides."""
    value = {
        "id": "candidate-fixture",
        "direction": "01-ai-ml",
        "title": "Synthetic work with a defined comparison",
        "url": "https://example.org/paper",
        "doi": "10.1234/synthetic",
        "version": "v2",
        "event_key": "synthetic-event",
        "published_at": "2026-09-06",
        "summary": (
            "The synthetic earlier baseline has a limitatio"
            "n. This work tests one change."
        ),
        "why_now": "A new synthetic comparison is available.",
        "access_scope": "abstract",
        "provenance": "discovery",
        "authors": "Synthetic Author",
        "affiliations": "Synthetic Institute",
        "venue": "Synthetic journal",
        "publication_status": "已发表",
        "contribution": (
            "Tests a specific previous assumption, not a new product name."
        ),
        "source_basis": "The synthetic primary abstract identifies the work.",
        "evidence_urls": [
            "https://example.org/paper",
            "https://example.org/authors",
        ],
    }
    return {**value, **changes}


def packet(identifier: str = "sample-packet") -> types.Payload:
    """Copy sample evidence with a caller-owned packet identity."""
    value = copy.deepcopy(rendering.SAMPLE_PACKETS[0])
    value["id"] = identifier
    value["is_fixture"] = False
    value["content_hash"] = contracts.content_hash(value["content"])
    return value


def edition(**changes: object) -> types.Payload:
    """Build a synthetic edition containing identifiable private sentinels."""
    return {
        "id": "edition-fixture",
        "issue_date": DAY,
        "state": "ready",
        "delivery_state": "not_requested",
        "packet_ids": ["sample-packet"],
        "is_fixture": False,
        "draft": copy.deepcopy(rendering.SAMPLE_DRAFT),
        "rendered": {
            "html": "<p>PRIVATE RENDERED BODY SHOULD NEVER BE COPIED</p>",
            "text": "PRIVATE RENDERED BODY SHOULD NEVER BE COPIED",
            "chart_png": base64.b64encode(PNG).decode(),
            "render_hash": "a" * 64,
        },
        "personal_digest": {
            "state": "current",
            "title": "私人事件",
            "summary": "PRIVATE SUMMARY",
            "items": [
                {"rank": 1, "title": "PRIVATE TASK", "detail": "PRIVATE DETAIL"}
            ],
            "task_count": 7,
            "time_window_hours": 24,
            "fetched_at": "2026-09-07T15:00:00Z",
            "source_label": "PRIVATE SOURCE",
            "limitations": "PRIVATE BOUNDARY",
            "is_fixture": False,
        },
        "usage": {
            "usage": {
                "input_tokens": "900",
                "cached_input_tokens": "700",
                "output_tokens": "100",
                "reasoning_output_tokens": "40",
                "total_tokens": "1000",
            },
            "invocations": 3,
            "missing_invocations": 0,
            "partial": False,
        },
        "publication": {
            "mode": "partial",
            "reason": "completed",
            "stories": [
                {
                    "story_id": "story-fixture",
                    "title": "Synthetic pending topic",
                    "candidate_ids": ["candidate-fixture"],
                    "priority": 1,
                    "disposition": "deferred",
                    "reason": "Synthetic independent review was not finished.",
                }
            ],
        },
        **changes,
    }


def block_text(blocks: list[types.Payload]) -> str:
    """Flatten rich-text blocks for public-content assertions."""
    return "\n".join(
        "".join(
            item["text"]["content"]
            for item in block[block["type"]].get("rich_text", [])
        )
        for block in blocks
    )


def project_material(
    value: types.Payload | None = None,
    *,
    evidence: list[types.Payload] | None = None,
    progress: str = "候选",
    fixture: bool = False,
) -> notion_content.Projection:
    """Project synthetic public material using fixed ledger metadata."""
    return notion_content.material_projection(
        candidate() if value is None else value,
        key="material:synthetic",
        first_seen=DAY,
        run_id="run-fixture",
        evidence=evidence,
        progress=progress,
        fixture=fixture,
    )
