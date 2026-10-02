"""Shared offline publication delivery builders and fakes."""

from __future__ import annotations

import newsletter.store as newsletter_store
import newsletter.types as types


def queue(
    store: newsletter_store.Store,
    *,
    projection_required: bool | None = False,
    key: str = "story-edition",
) -> tuple[types.EditionRecord, types.Payload, types.Payload, types.Payload]:
    """Queue a bound synthetic edition for publication-delivery tests."""
    packet = store.put_packet(
        {
            "request_key": "packet",
            "workflow_id": "offline-test",
            "content": {
                "title": "模拟本地证据",
                "body": "离线测试，不是真实新闻。",
                "sources": [
                    {
                        "id": "source",
                        "title": "模拟来源",
                        "url": "https://example.org/synthetic",
                        "excerpt": "测试材料。",
                        "access_scope": "full_text",
                    }
                ],
                "tags": ["fixture"],
            },
        }
    )
    binding: types.Payload = {
        "run_id": key,
        "required_packets": [packet["id"]],
        "result": {
            "draft": {
                "subject": "模拟刊期",
                "title": "模拟刊期",
                "sections": [
                    {
                        "kind": "feature",
                        "heading": "离线测试",
                        "paragraphs": [
                            {
                                "text": "持久保存的本地证据。",
                                "citations": [packet["id"] + "/source"],
                            }
                        ],
                    }
                ],
            },
            "review": {"passed": True, "findings": []},
        },
    }
    if projection_required is not None:
        binding["projection_required"] = projection_required
    request = {
        "request_key": key,
        "issue_date": "2026-09-07",
        "packet_ids": [packet["id"]],
    }
    return (
        store.prepare(request, workflow_binding=binding),
        packet,
        request,
        binding,
    )
