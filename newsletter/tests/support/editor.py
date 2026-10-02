"""Shared offline editor builders and fakes."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import dataclasses
import inspect
import json
import pathlib
import types
from typing import TYPE_CHECKING

import pydantic
import pytest

import newsletter.codex_runtime as codex_runtime
import newsletter.contracts as contracts
import newsletter.editor as editor
import newsletter.types as newsletter_types

if TYPE_CHECKING:
    import openai_codex


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


@dataclasses.dataclass
class SDKEvent:
    """SDK notification shape consumed by the real response collector."""

    method: str
    payload: newsletter_types.Payload


class FakeTurn:
    """Stream synthetic research and final events with explicit failures."""

    def __init__(
        self,
        bundle: newsletter_types.Payload | str,
        *,
        research: bool = True,
        failure: newsletter_types.Payload | None = None,
        hang: bool = False,
        omit_action: str | None = None,
    ) -> None:
        self.bundle = bundle
        self.research = research
        self.failure = failure
        self.hang = hang
        self.omit_action = omit_action
        self.interrupted = False
        self.started = asyncio.Event()

    async def stream(self) -> AsyncIterator[SDKEvent]:
        """Yield bounded notification events without creating an SDK process."""
        self.started.set()
        if self.hang:
            await asyncio.Event().wait()
        if self.research:
            for action in (
                {"type": "search", "query": "public topic"},
                {"type": "openPage", "url": "https://example.com/evidence"},
            ):
                if action["type"] == self.omit_action:
                    continue
                yield SDKEvent(
                    method="item/completed",
                    payload={"item": {"type": "webSearch", "action": action}},
                )
        yield SDKEvent(
            method="item/completed",
            payload={
                "item": {
                    "type": "agentMessage",
                    "phase": "final_answer",
                    "text": self.bundle
                    if isinstance(self.bundle, str)
                    else json.dumps(self.bundle),
                }
            },
        )
        yield SDKEvent(
            method="turn/completed",
            payload={
                "turn": {
                    "status": "failed" if self.failure else "completed",
                    "error": self.failure,
                }
            },
        )

    async def interrupt(self) -> None:
        """Record timeout or cancellation cleanup for assertions."""
        self.interrupted = True


@dataclasses.dataclass
class FakeSDKState:
    """Observable SDK state, preserving real SDK call-signature validation."""

    turn: FakeTurn
    account_type: str = "chatgpt"
    closed: bool = False
    close_error: Exception | None = None
    close_hang: bool = False
    started: bool = False
    prompt: newsletter_types.Payload | None = None
    thread_options: dict[str, object] | None = None
    thread_starts: int = 0
    config: openai_codex.CodexConfig | None = None
    skills_response: newsletter_types.Payload | None = None
    skills_checked: bool = False
    turns: list[FakeTurn] = dataclasses.field(default_factory=list)
    prompts: list[newsletter_types.Payload] = dataclasses.field(
        default_factory=list
    )
    schema: newsletter_types.Payload | None = None


@dataclasses.dataclass
class _AccountKind:
    type: str


@dataclasses.dataclass
class _Account:
    root: _AccountKind


@dataclasses.dataclass
class _AccountResponse:
    account: _Account


@pytest.fixture
def fake_sdk(
    monkeypatch: pytest.MonkeyPatch, bundle: newsletter_types.Payload
) -> FakeSDKState:
    """Install inert SDK constructors checked against pinned signatures."""
    # Importing the actual SDK is inert; its real constructors/method signatures
    # constrain the fake. No actual AsyncCodex object is ever instantiated.
    sdk = pytest.importorskip("openai_codex")
    sdk_api = pytest.importorskip("openai_codex.api")
    state = FakeSDKState(turn=FakeTurn(bundle))

    class FakeClient:
        """Expose runtime account, skills and thread operations only."""

        def __init__(self, config: openai_codex.CodexConfig) -> None:
            state.config = config
            self._client = self

        async def request[Response: pydantic.BaseModel](
            self,
            method: str,
            params: newsletter_types.Payload,
            *,
            response_model: type[Response],
        ) -> Response:
            """Validate disabled-skill fixtures with the SDK response model."""
            assert method == "skills/list" and params["forceReload"] is True
            state.skills_checked = True
            assert state.config is not None and state.config.env is not None
            value = state.skills_response or {
                "data": [
                    {
                        "cwd": state.config.cwd,
                        "errors": [],
                        "skills": [
                            {
                                "path": path,
                                "scope": "system",
                                "enabled": False,
                                "name": pathlib.Path(path).parent.name,
                                "description": "disabled fixture skill",
                            }
                            for path in sorted(
                                codex_runtime.skill_paths(
                                    pathlib.Path(state.config.env["CODEX_HOME"])
                                )
                            )
                        ],
                    }
                ]
            }
            return response_model.model_validate(value)

        async def __aenter__(self) -> FakeClient:
            """Record entry without launching an app-server process."""
            state.started = True
            return self

        async def account(
            self, *, refresh_token: bool = False
        ) -> _AccountResponse:
            """Return the selected account kind without reading credentials."""
            assert refresh_token is False
            return _AccountResponse(_Account(_AccountKind(state.account_type)))

        async def thread_start(self, **kwargs: object) -> FakeThread:
            """Check the thread signature and capture requested isolation."""
            inspect.signature(sdk.AsyncCodex.thread_start).bind(self, **kwargs)
            state.thread_starts += 1
            state.thread_options = kwargs
            return FakeThread()

        async def close(self) -> None:
            """Record cleanup of the inert client."""
            if state.close_error is not None:
                raise state.close_error
            if state.close_hang:
                await asyncio.Event().wait()
            state.closed = True

    class FakeThread:
        """Serve queued fake turns while enforcing the pinned turn signature."""

        async def turn(self, prompt: str, **kwargs: object) -> FakeTurn:
            """Capture a JSON prompt and serve exactly one selected response."""
            inspect.signature(sdk_api.AsyncThread.turn).bind(
                self, prompt, **kwargs
            )
            state.prompt = json.loads(prompt)
            assert state.prompt is not None
            state.prompts.append(state.prompt)
            schema = kwargs["output_schema"]
            assert isinstance(schema, dict)
            state.schema = schema
            return state.turns.pop(0) if state.turns else state.turn

    monkeypatch.setattr(
        codex_runtime,
        "load_sdk",
        lambda: types.SimpleNamespace(
            AsyncCodex=FakeClient,
            CodexConfig=sdk.CodexConfig,
            Sandbox=sdk.Sandbox,
            ApprovalMode=sdk.ApprovalMode,
        ),
    )
    return state


def live_editor(
    tmp_path: pathlib.Path,
    *,
    model: str = "gpt-6-sol",
    timeout_seconds: float = 840,
) -> editor.CodexEditor:
    """Build a real editor with an isolated empty authentication directory."""
    dedicated = tmp_path / "dedicated-codex"
    dedicated.mkdir(exist_ok=True)
    return editor.CodexEditor(dedicated, model, timeout_seconds=timeout_seconds)


def discovery_turn(
    value: newsletter_types.Payload | str, *, omit_action: str
) -> FakeTurn:
    """Simulate research events that omit one provenance action."""
    return FakeTurn(value, omit_action=omit_action)
