"""Synthetic final Model Router wire responses, without provider protocols."""

import dataclasses
import email.utils
import json
import math
import time
import uuid
from typing import Any

from tests.fakes.server import FakeServer, Recorded, Reply

GENERATE_PATH = "/api/model/v1/generations:generate"
PUBLIC_MODELS = ("gemini-3.5-flash-lite", "gemini-3.8-flash", "gpt-6.1-sol", "openai/gpt-6.1-sol")
REPORTED = {"gemini-3.5-flash-lite": "model-a", "gemini-3.8-flash": "gemini-probe"}


def text_reply(text: str, *, tokens: int = 100, model: str = "fake") -> Reply:
    return Reply(
        200,
        {
            "output": text,
            "model": model,
            "usage": {
                "available": True,
                "input_tokens": tokens // 2,
                "output_tokens": tokens - tokens // 2,
            },
        },
    )


def error_reply(status: int, headers: dict[str, str] | None = None) -> Reply:
    reason = "MODEL_QUOTA" if status == 429 else "MODEL_AUTH" if status in {400, 401, 403} else "MODEL_UNAVAILABLE"
    retry = (headers or {}).get("retry-after", "0")
    try:
        seconds = int(retry)
    except ValueError:
        seconds = max(0, math.ceil(email.utils.parsedate_to_datetime(retry).timestamp() - time.time()))
    return Reply(
        200,
        {
            "usage": {"available": False},
            "error": {
                "code": 8 if status == 429 else 16 if status in {400, 401, 403} else 14,
                "reason": reason,
                "message": "Synthetic model failure",
                "retry_after_seconds": seconds,
            },
        },
    )


def model_path(_model: str = "") -> str:
    return GENERATE_PATH


@dataclasses.dataclass(frozen=True)
class ModelCall:
    model: str
    requested_model: str
    system: str
    user: str
    response_schema: dict[str, Any] | None
    at: float

    @property
    def response_mime_type(self) -> str | None:
        return "application/json" if self.response_schema is not None else None

    @classmethod
    def of(cls, request: Recorded) -> "ModelCall":
        body = request.json()
        public = body.get("model", "")
        schema = body.get("output_schema_json", "")
        return cls(
            REPORTED.get(public, public),
            public,
            "\n\n".join(item["text"] for item in body.get("instructions", [])),
            body.get("input", ""),
            json.loads(schema) if schema else None,
            request.at,
        )


class ModelRouterFake(FakeServer):
    def __init__(self) -> None:
        super().__init__()
        self.route("POST", GENERATE_PATH, self._answer)
        self.route("GET", "/api/model/v1/models", self._catalog)

    def queue_generate(self, reply: Reply, model: str | None = None) -> None:
        self.queue("POST", GENERATE_PATH + "#" + (model or "*"), reply)

    def queue_keys(self, request: Recorded) -> list[tuple[str, str]]:
        if request.path != GENERATE_PATH:
            return super().queue_keys(request)
        call = ModelCall.of(request)
        return [("POST", GENERATE_PATH + "#" + call.model), ("POST", GENERATE_PATH + "#*"), ("POST", GENERATE_PATH)]

    def calls(self, model: str | None = None) -> list[ModelCall]:
        calls = [ModelCall.of(row) for row in self.received("POST", GENERATE_PATH)]
        return [call for call in calls if model is None or call.model == model]

    def calls_mentioning(self, needle: str) -> list[ModelCall]:
        return [call for call in self.calls() if needle in call.user]

    def _next_reply(self, request: Recorded) -> Reply:
        reply = super()._next_reply(request)
        if request.path == GENERATE_PATH and isinstance(reply.body, dict):
            body = dict(reply.body)
            selected = request.json()["model"]
            body["name"] = "requests/" + str(uuid.uuid4())
            if body.get("model", "fake") == "fake":
                body["model"] = REPORTED.get(selected, selected)
            return dataclasses.replace(reply, body=body)
        return reply

    def _catalog(self, _request: Recorded, _match: Any) -> Reply:
        return Reply(
            200,
            {
                "models": [
                    {
                        "id": model,
                        "configured": True,
                        "kind": "text",
                        "provider": "openai"
                        if model.startswith("openai/")
                        else "codex"
                        if model.startswith("gpt-")
                        else "google",
                    }
                    for model in PUBLIC_MODELS
                ]
            },
        )

    def _answer(self, request: Recorded, _match: Any) -> Reply:
        call = ModelCall.of(request)
        tokens = math.ceil(len(call.system + call.user) / 4) + 20
        if call.response_schema is not None:
            count = min(int(call.response_schema.get("maxItems", 3)), 3)
            items = [
                {"rank": rank, "title": f"合成任务 {rank}", "reason": f"合成理由 {rank}"}
                for rank in range(1, count + 1)
            ]
            return text_reply(json.dumps(items, ensure_ascii=False), tokens=tokens)
        return text_reply(f"合成摘要（{call.model}）：{len(call.user)} 字符。", tokens=tokens)
