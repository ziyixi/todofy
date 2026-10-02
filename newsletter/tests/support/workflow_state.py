"""Shared offline workflow state builders and fakes."""

from __future__ import annotations

import newsletter.store as newsletter_store
import newsletter.types as types


def packet(store: newsletter_store.Store, key: str) -> types.Payload:
    """Persist a synthetic public packet under a caller-supplied key."""
    return store.put_packet(
        {
            "request_key": key,
            "workflow_id": "synthetic",
            "content": {
                "title": "Synthetic " + key,
                "body": "Only an offline state-machine fixture, not news.",
                "sources": [
                    {
                        "id": "source",
                        "title": "Synthetic source",
                        "url": "https://example.org/fixture",
                        "excerpt": "Synthetic test only.",
                        "access_scope": "full_text",
                    }
                ],
                "tags": ["fixture"],
            },
        }
    )


def binding(run: str, packets: list[types.Payload]) -> types.Payload:
    """Bind a synthetic approved draft to its required packets."""
    return {
        "run_id": run,
        "result": {
            "draft": {"title": "Synthetic draft"},
            "review": {"passed": True, "findings": []},
        },
        "required_packets": [item["id"] for item in packets],
    }


def request(key: str, packets: list[types.Payload]) -> types.Payload:
    """Build an edition preparation request for the supplied packets."""
    return {
        "request_key": key,
        "issue_date": "2026-09-06",
        "packet_ids": [p["id"] for p in packets],
    }


def ready(
    store: newsletter_store.Store,
    key: str,
    packets: list[types.Payload],
    required: list[types.Payload] | None = None,
    run: str | None = None,
) -> types.EditionRecord:
    """Persist a ready edition without running a model or renderer."""
    edition = store.prepare(
        request(key, packets),
        workflow_binding=binding(
            run or key, packets if required is None else required
        ),
    )
    # Test the reservation boundary, not the already-covered model/renderer.
    return store.finish(
        edition["id"],
        state="ready",
        review={"passed": True, "findings": []},
        rendered={
            "html": "synthetic",
            "text": "synthetic",
            "chart_png": "",
            "render_hash": key + "-hash",
        },
    )


def approval(
    edition: types.EditionRecord, key: str = "send-fixture"
) -> types.Payload:
    """Build a send approval bound to the edition render hash."""
    return {
        "id": edition["id"],
        "request_key": key,
        "expected_render_hash": edition["rendered"]["render_hash"],
    }
