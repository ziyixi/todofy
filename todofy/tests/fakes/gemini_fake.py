"""Fake Gemini ``generateContent`` / ``countTokens`` (v1beta REST), after sut/fakes/gemini.

Each operation has its own FIFO queue, per model or for any model; unqueued calls get a
deterministic answer with ``usageMetadata``. A request carrying a ``responseSchema``
(the recommendation call) is answered with JSON that fits it.
"""

import json
import math
from dataclasses import dataclass
from typing import Any

from tests.fakes.server import FakeServer, Recorded, Reply

API_KEY = "fake-gemini-key"
MODELS_PREFIX = "/v1beta/models/"
_PATH = r"/v1beta/models/(?P<model>[^/:]+):(?P<operation>generateContent|countTokens)"
_STATUS = {400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND"}


def model_path(model: str, operation: str = "generateContent") -> str:
    return f"{MODELS_PREFIX}{model}:{operation}"


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


def text_reply(text: str, *, tokens: int = 100, model: str = "fake") -> Reply:
    return Reply(
        200,
        {
            "candidates": [
                {"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP", "index": 0}
            ],
            "usageMetadata": {
                "promptTokenCount": tokens // 2,
                "candidatesTokenCount": tokens - tokens // 2,
                "totalTokenCount": tokens,
            },
            "modelVersion": model,
        },
    )


def error_reply(status: int, headers: dict[str, str] | None = None) -> Reply:
    status_name = _STATUS.get(status, "RESOURCE_EXHAUSTED" if status == 429 else "UNAVAILABLE")
    return Reply(status, {"error": {"code": status, "message": "fake failure", "status": status_name}}, headers or {})


def _texts(content: Any) -> str:
    parts = content.get("parts", []) if isinstance(content, dict) else []
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict))


@dataclass(frozen=True)
class GeminiCall:
    model: str
    operation: str
    api_key: str | None
    system: str
    user: str
    response_mime_type: str | None
    response_schema: dict[str, Any] | None
    at: float

    @classmethod
    def of(cls, request: Recorded) -> "GeminiCall":
        model, _, operation = request.path.removeprefix(MODELS_PREFIX).partition(":")
        body = request.json() if request.body else {}
        config = body.get("generationConfig") or body.get("generation_config") or {}
        system = body.get("systemInstruction") or body.get("system_instruction") or {}
        return cls(
            model=model,
            operation=operation,
            api_key=request.headers.get("x-goog-api-key"),
            system=_texts(system),
            user="".join(_texts(content) for content in body.get("contents", [])),
            response_mime_type=config.get("responseMimeType") or config.get("response_mime_type"),
            response_schema=config.get("responseSchema") or config.get("response_schema"),
            at=request.at,
        )


class GeminiFake(FakeServer):
    def __init__(self, api_key: str = API_KEY) -> None:
        super().__init__()
        self.api_key = api_key
        self.route("POST", _PATH, self._answer)

    def queue_generate(self, reply: Reply, model: str | None = None) -> None:
        """``model=None`` serves the next call to any model."""
        self.queue("POST", model_path(model or "*"), reply)

    def queue_count_tokens(self, reply: Reply, model: str | None = None) -> None:
        self.queue("POST", model_path(model or "*", "countTokens"), reply)

    def queue_keys(self, request: Recorded) -> list[tuple[str, str]]:
        operation = request.path.rpartition(":")[2]
        return [(request.method, request.path), (request.method, model_path("*", operation))]

    def authorize(self, request: Recorded) -> Reply | None:
        if request.path.startswith(MODELS_PREFIX) and request.headers.get("x-goog-api-key", "").strip() != self.api_key:
            return error_reply(401)
        return None

    def calls(self, model: str | None = None, operation: str = "generateContent") -> list[GeminiCall]:
        calls = [GeminiCall.of(r) for r in self.received("POST") if r.path.startswith(MODELS_PREFIX)]
        return [c for c in calls if c.operation == operation and (model is None or c.model == model)]

    def calls_mentioning(self, needle: str) -> list[GeminiCall]:
        """generateContent calls whose user turn contains ``needle`` (e.g. a mail's marker text)."""
        return [call for call in self.calls() if needle in call.user]

    def _answer(self, request: Recorded, match: Any) -> Reply:
        call = GeminiCall.of(request)
        tokens = estimate_tokens(call.system + call.user) + 20
        if match["operation"] == "countTokens":
            return Reply(200, {"totalTokens": tokens})
        if call.response_schema is not None:
            count = min(int(call.response_schema.get("maxItems", 3)), 3)
            items = [
                {"rank": rank, "title": f"合成任务 {rank}", "reason": f"合成理由 {rank}"}
                for rank in range(1, count + 1)
            ]
            return text_reply(json.dumps(items, ensure_ascii=False), tokens=tokens, model=call.model)
        return text_reply(f"合成摘要（{call.model}）：{len(call.user)} 字符。", tokens=tokens, model=call.model)
