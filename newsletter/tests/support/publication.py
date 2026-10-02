"""Shared offline publication builders and fakes."""

from __future__ import annotations

import newsletter.contracts as contracts
import newsletter.rendering as rendering
import newsletter.types as types
import newsletter.workflow.components as components
import newsletter.workflow.publication as publication

DAY = "2026-09-06"

URL = "https://example.org/research"


def task(number: int = 1, **changes: object) -> types.Payload:
    """Build a synthetic selected topic with optional boundary-test edits."""
    return {
        "id": f"story-{number}",
        "candidate_ids": [f"candidate-{number}"],
        "question": f"Synthetic research question {number}",
        "why": "A concrete new result merits investigation.",
        "priority": number,
        "evidence_context": (
            "Read the actual study and its controlled comparison."
        ),
        "source_urls": [URL],
        **changes,
    }


def packet(number: int = 1) -> types.Payload:
    """Build a self-contained synthetic public packet."""
    content = {
        "title": "Synthetic material",
        "body": "Only a test fixture, never material for a real newsletter.",
        "sources": [
            {
                "id": "original",
                "title": "Synthetic original source",
                "url": f"{URL}/{number}",
                "published_at": DAY,
                "access_scope": "full_text",
                "excerpt": "A controlled comparison was reported.",
            }
        ],
        "tags": ["test-fixture"],
    }
    return {
        "id": f"packet-{number}",
        "workflow_id": "test-publication",
        "producer_id": "test",
        "content": content,
        "content_hash": contracts.content_hash(content),
        "created_at": DAY + "T08:00:00Z",
        "is_fixture": True,
    }


def story(number: int = 1, **changes: object) -> types.Payload:
    """Build a cited synthetic story with optional boundary-test edits."""
    return {
        "story_id": f"story-{number}",
        "title": f"Synthetic verified topic {number}",
        "kind": "feature",
        "paragraphs": [
            {
                "text": f"Synthetic result {number} with its boundary intact.",
                "citations": [f"packet-{number}/original"],
            }
        ],
        "limitations": "Synthetic limitation must remain beside its claim.",
        **changes,
    }


def receipt(
    component: str,
    value: object,
    packets: list[types.Payload],
    **changes: object,
) -> types.Payload:
    """Bind an independent synthetic review to exact content and sources."""
    return {
        "round": "initial",
        "component": component,
        "status": "approved",
        "content_hash": contracts.content_hash(value),
        "findings": ["Synthetic independent review passed."],
        "searched": True,
        "opened": True,
        "opened_urls": [
            source["url"] for p in packets for source in p["content"]["sources"]
        ],
        "writer_job_id": "writer-job",
        "reviewer_job_id": "independent-reviewer-job",
        **changes,
    }


def result(
    number: int = 1,
    mode: str = "brief",
    *,
    content: types.Payload | bool | None = True,
    signal: bool = False,
    **changes: object,
) -> types.Payload:
    """Build a checkpoint with matching synthetic content and review hashes."""
    packets = [packet(number)]
    value: types.Payload | None = None
    if content is True:
        value = story(number)
    elif content:
        value = content
    confirmed = (
        story(number, title="Confirmed event, uncertain significance")
        if signal
        else None
    )
    assessments = []
    if value:
        assessments.append(
            receipt("body", components.body_content(value), packets)
        )
        for field, component in (
            ("recommended_reading", "reading"),
            ("chart", "chart"),
        ):
            if field in value:
                assessments.append(receipt(component, value[field], packets))
    if confirmed:
        assessments.append(receipt("signal", confirmed, packets))
    return {
        "story_id": f"story-{number}",
        "mode": mode,
        "content": value,
        "signal": confirmed,
        "packets": packets,
        "assessments": assessments,
        "issues": [],
        "reason": "Synthetic approved checkpoint"
        if value or confirmed
        else "unavailable",
        "provenance": {"packets_hash": contracts.content_hash(packets)},
        **changes,
    }


def delivery_receipt(
    repository: publication.PublicationRepository,
    run_id: str,
    built: types.Payload,
    state: types.DeliveryState = "simulated",
    *,
    verification: bool = False,
) -> types.EditionRecord:
    """Persist an edition and optionally its simulated delivery receipt."""
    store = repository.store
    store.save_workflow_supplements(run_id, built["packets"])
    ids = [packet["id"] for packet in built["packets"]]
    issue = store.prepare(
        {"request_key": run_id, "issue_date": DAY, "packet_ids": ids},
        workflow_binding={
            "run_id": run_id,
            "result": {"draft": built["draft"], "review": built["review"]},
            "required_packets": ids,
            "projection_required": False,
        },
    )
    rendered = rendering.render_edition(
        built["draft"], built["packets"], DAY, is_fixture=True
    )
    store.finish(
        issue["id"],
        state="ready",
        draft=built["draft"],
        review=built["review"],
        rendered=rendered,
    )
    if state != "not_requested":
        reserve = (
            store.reserve_verification_send
            if verification
            else store.reserve_send
        )
        reserve(
            {
                "id": issue["id"],
                "request_key": "send-" + run_id,
                "expected_render_hash": rendered["render_hash"],
            }
        )
        store.finish(issue["id"], delivery_state=state)
    return issue
