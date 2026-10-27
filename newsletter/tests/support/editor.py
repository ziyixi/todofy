"""Shared offline editor builders and fakes."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import pathlib
from typing import cast

import model_router_client as models
import pytest

import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.model_client as model_client
import newsletter.settings as settings
import newsletter.types as newsletter_types


@pytest.fixture
def packet() -> newsletter_types.Payload:
    """Build a synthetic packet with a stable source and content hash."""
    content = {
        "title": "测试材料",
        "body": "这是显眼的虚构 fixture，不是真实新闻。",
        "sources": [
            {
                "id": "s1",
                "title": "测试来源",
                "url": "https://example.com/evidence",
                "excerpt": "虚构测试数据",
                "access_scope": "full_text",
                "published_at": "",
            }
        ],
        "tags": ["fixture"],
    }
    return {
        "id": "p1",
        "workflow_id": "fixture",
        "producer_id": "fixture",
        "content_hash": contracts.content_hash(content),
        "created_at": "2026-09-05T00:00:00Z",
        "is_fixture": True,
        "content": content,
    }


@pytest.fixture
def bundle() -> newsletter_types.Payload:
    """Build a validated synthetic draft and independent review response."""
    return {
        "draft": {
            "subject": "测试主题",
            "title": "测试标题",
            "introduction": "测试说明",
            "sections": [
                {
                    "kind": "feature",
                    "heading": "测试主读",
                    "paragraphs": [
                        {"text": "测试论断", "citations": ["p1/s1"]}
                    ],
                    "limitations": "仅测试",
                }
            ],
            "limitations": "仅测试",
        },
        "review": {"passed": True, "findings": ["测试复核"]},
        "supplemental_packets": [],
    }


class FakeTurn:
    """Serve one synthetic final response and observed research actions."""

    def __init__(
        self,
        bundle: newsletter_types.Payload | str,
        *,
        research: bool = True,
        failure: newsletter_types.Payload | None = None,
        hang: bool = False,
        omit_action: str | None = None,
    ) -> None:
        self.bundle, self.research, self.failure = bundle, research, failure
        self.hang, self.omit_action = hang, omit_action
        self.interrupted = False
        self.started = asyncio.Event()
        self.usage: models.Usage | None = None

    async def result(self, name: str) -> models.Generation:
        """Return a normalized receipt without provider-specific events."""
        self.started.set()
        if self.hang:
            await asyncio.Event().wait()
        return models.Generation(
            name=name,
            output=self.bundle
            if isinstance(self.bundle, str)
            else json.dumps(self.bundle),
            usage=self.usage,
            error=models.ModelError(
                code=self.failure["code"], reason="MODEL_FAILURE"
            )
            if self.failure
            else None,
            observations=models.Observations(
                searched=self.research and self.omit_action != "search",
                opened_urls=("https://example.com/evidence",)
                if self.research and self.omit_action != "openPage"
                else (),
            ),
        )


@dataclasses.dataclass
class FakeRouterState:
    """Observable shared-client operations with no provider implementation."""

    turn: FakeTurn
    closed: bool = False
    close_error: Exception | None = None
    close_hang: bool = False
    started: bool = False
    prompt: newsletter_types.Payload | None = None
    thread_starts: int = 0
    turns: list[FakeTurn] = dataclasses.field(default_factory=list)
    prompts: list[newsletter_types.Payload] = dataclasses.field(
        default_factory=list
    )
    schema: newsletter_types.Payload | None = None
    config: models.CreateConversationRequest | None = None
    conversation: models.CreateConversationRequest | None = None
    active: FakeTurn | None = None

    async def create_conversation(
        self, request: models.CreateConversationRequest
    ) -> None:
        """Capture immutable generic model configuration."""
        self.started = True
        self.thread_starts += 1
        self.config = request
        self.schema = json.loads(request.output_schema_json)
        self.conversation = request

    async def generate(
        self, request: models.GenerateRequest
    ) -> models.Generation:
        """Serve a call within the same remote context."""
        assert self.conversation is not None
        assert request.conversation == self.conversation.name
        self.prompt = json.loads(request.input)
        self.prompts.append(self.prompt)
        self.active = self.turns.pop(0) if self.turns else self.turn
        return await self.active.result(
            "requests/synthetic-" + str(len(self.prompts))
        )

    async def close_conversation(
        self, request: models.CloseConversationRequest
    ) -> None:
        """Confirm cleanup, or deliberately leave it uncertain."""
        if self.close_error:
            raise self.close_error
        if self.close_hang:
            await asyncio.Event().wait()
        if self.active:
            self.active.interrupted = True
        self.closed = True


@pytest.fixture
def fake_router(
    monkeypatch: pytest.MonkeyPatch, bundle: newsletter_types.Payload
) -> FakeRouterState:
    """Inject the shared client boundary; never construct an SDK."""
    state = FakeRouterState(FakeTurn(bundle))
    monkeypatch.setattr(
        model_client,
        "configured_client",
        lambda *_args, **_kwargs: cast(models.ModelClient, state),
    )
    return state


def live_editor(
    tmp_path: pathlib.Path,
    *,
    model: str = "gpt-6.1-sol",
    timeout_seconds: float = 840,
) -> editor.ModelEditor:
    """Build the production editor with an injected remote model client."""
    return editor.ModelEditor(
        model_client.configured_client(settings.Settings()),
        model,
        timeout_seconds=timeout_seconds,
    )


def discovery_turn(
    value: newsletter_types.Payload | str, *, omit_action: str
) -> FakeTurn:
    """Return research observations with one deliberately missing action."""
    return FakeTurn(value, omit_action=omit_action)
