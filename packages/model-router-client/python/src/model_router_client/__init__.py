"""Provider-neutral async client using the generated root wire contract."""

import dataclasses
import json
import re
from collections.abc import Awaitable, Callable
from typing import TypeVar, cast
from urllib.parse import quote, urlencode

from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    HTTP_BINDINGS,
    CloseConversationRequest,
    Conversation,
    CreateConversationRequest,
    Embedding,
    EmbedRequest,
    GenerateRequest,
    Generation,
    GenerationConfig,
    GetConversationRequest,
    Instruction,
    ListModelsRequest,
    ListModelsResponse,
    Model,
    ModelError,
    Observations,
    Parameters,
    Usage,
)
from ziyixi_proto.rpc_status import CODE
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

__all__ = [
    "CloseConversationRequest",
    "Conversation",
    "CreateConversationRequest",
    "EmbedRequest",
    "Embedding",
    "GenerateRequest",
    "Generation",
    "GenerationConfig",
    "GetConversationRequest",
    "HttpCall",
    "HttpResult",
    "Instruction",
    "ListModelsRequest",
    "ListModelsResponse",
    "Model",
    "ModelClient",
    "ModelError",
    "ModelRouterError",
    "Observations",
    "Parameters",
    "Transport",
    "Usage",
]


@dataclasses.dataclass(frozen=True)
class HttpCall:
    """Bound request for an injected authenticated HTTP transport."""

    method: str
    path: str
    body: bytes | None
    timeout_seconds: float


@dataclasses.dataclass(frozen=True)
class HttpResult:
    """Bounded HTTP response bytes; no provider response escapes the router."""

    status: int
    body: bytes


class ModelRouterError(Exception):
    """Safe RPC classification without response text or caller content."""

    def __init__(self, code: str, reason: str = "MODEL_ROUTER_FAILURE"):
        self.code = code if isinstance(code, str) and code in CODE else "UNKNOWN"
        self.reason = (
            reason
            if re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", reason)
            else "MODEL_ROUTER_FAILURE"
        )
        super().__init__(self.code)


Transport = Callable[[HttpCall], Awaitable[HttpResult]]
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
Response = TypeVar("Response")
_BINDINGS = {
    binding.rpc: binding
    for binding in HTTP_BINDINGS
    if binding.service == "modelrouter.inference.v1.ModelService"
}


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate field")
        value[key] = item
    return value


class ModelClient:
    """Final-result client; retries and business state belong to the caller."""

    def __init__(self, transport: Transport):
        self.transport = transport

    async def _call(
        self, rpc: str, request: object, response: type[Response], timeout: float
    ) -> Response:
        binding = _BINDINGS[rpc]
        values = to_wire(request)
        path = binding.path_template
        for match in tuple(re.finditer(r"\{([a-z_]+)(?:=[^}]+)?\}", path)):
            field = match[1]
            value = values.pop(field)
            path = path.replace(match[0], quote(value, safe="/"))
        body = None
        if binding.body == "*":
            body = values
            values = {}
        elif binding.body:
            body = values.pop(binding.body)
        if values:
            path += "?" + urlencode(values)
        call = HttpCall(
            binding.method,
            path,
            None
            if body is None
            else json.dumps(
                body, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ).encode(),
            timeout,
        )
        result = await self.transport(call)
        if len(result.body) > MAX_RESPONSE_BYTES:
            raise ModelRouterError("UNAVAILABLE", "MODEL_ROUTER_INVALID_RESPONSE")
        try:
            value = json.loads(result.body, object_pairs_hook=_unique)
            if not 200 <= result.status < 300:
                error = value.get("error", {}) if isinstance(value, dict) else {}
                if not isinstance(error, dict):
                    raise ValueError("invalid RPC error")
                code = error.get("status", "UNKNOWN")
                raise ModelRouterError(code)
            return cast(Response, from_wire(response, value, strict=True).message)
        except (ValueError, UnicodeError, WireJsonError, RecursionError):
            raise ModelRouterError(
                "UNAVAILABLE", "MODEL_ROUTER_INVALID_RESPONSE"
            ) from None

    async def list_models(self) -> ListModelsResponse:
        """Read configured capabilities without starting inference."""
        return await self._call(
            "ListModels", ListModelsRequest(), ListModelsResponse, 30
        )

    async def generate(self, request: GenerateRequest) -> Generation:
        """Wait for one final response with provider-normalized per-call usage."""
        return await self._call(
            "Generate", request, Generation, (request.timeout_ms or 110000) / 1000 + 15
        )

    async def embed(self, request: EmbedRequest) -> Embedding:
        """Generate vectors in input order."""
        return await self._call("Embed", request, Embedding, 125)

    async def create_conversation(
        self, request: CreateConversationRequest
    ) -> Conversation:
        """Create a finite context with a caller-assigned durable identity."""
        return await self._call("CreateConversation", request, Conversation, 125)

    async def get_conversation(self, name: str) -> Conversation:
        """Read context liveness and confirmed cleanup state."""
        return await self._call(
            "GetConversation", GetConversationRequest(name=name), Conversation, 30
        )

    async def close_conversation(
        self, request: CloseConversationRequest
    ) -> Conversation:
        """Wait for remote SDK/process/workspace cleanup acknowledgement."""
        return await self._call("CloseConversation", request, Conversation, 30)
