"""Synthetic final Model Router wire responses, without provider protocols."""

import dataclasses
import email.utils
import json
import math
import time
from typing import Any

from tests.fakes.server import FakeServer, Recorded, Reply

GENERATE_PATH = "/api/model/v1/generations:generate"
PUBLIC_MODELS = ("models/gemini-email", "models/gemini-report", "models/sol-6-1")
REPORTED = {"models/gemini-email": "model-a", "models/gemini-report": "gemini-probe"}


def text_reply(text: str, *, tokens: int = 100, model: str = "fake", attempts: int = 1) -> Reply:
    return Reply(
        200,
        {
            "state": "succeeded",
            "output": text,
            "reported_model": model,
            "attempt_count": attempts,
            "upstream_started": True,
            "finish_reason": "complete",
            "usage": {
                "available": True,
                "input_tokens": tokens // 2,
                "output_tokens": tokens - tokens // 2,
                "total_tokens": tokens,
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
            "state": "failed",
            "attempt_count": 1,
            "upstream_started": True,
            "finish_reason": "interrupted",
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
        config = body.get("config", {})
        public = config.get("model", "")
        schema = config.get("output_schema_json", "")
        return cls(
            REPORTED.get(public, public),
            public,
            "\n\n".join(item["text"] for item in config.get("instructions", [])),
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
        if request.path == GENERATE_PATH and isinstance(reply.body, dict) and "state" in reply.body:
            body = dict(reply.body)
            sent = request.json()
            public = sent["config"]["model"]
            body.update(name="requests/" + sent["request_id"], model=public)
            if body.get("reported_model") == "fake":
                body["reported_model"] = REPORTED.get(public, public)
            return dataclasses.replace(reply, body=body)
        return reply

    def _catalog(self, _request: Recorded, _match: Any) -> Reply:
        return Reply(
            200, {"models": [{"name": model, "configured": True, "generation": True} for model in PUBLIC_MODELS]}
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
