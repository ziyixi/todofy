"""Private transport for the provider-neutral generated model contract."""

import asyncio
import contextlib
import json
from collections.abc import Awaitable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from ziyixi_proto.codex.inference.v1.inference_pb import (
    RunInferenceRequest,
    RunInferenceResponse,
)
from ziyixi_proto.http_routes import decode_request
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    HTTP_BINDINGS,
    CloseConversationRequest,
    CreateConversationRequest,
    GenerateRequest,
    GetConversationRequest,
    ListModelsRequest,
)
from ziyixi_proto.rpc_status import RpcError, status_body
from ziyixi_proto.wire_json import WireJsonError, to_wire

from codex_gateway.modelrouter import MODEL_MAP, ModelExecutor
from codex_gateway.monitoring import InferenceMonitor

HEARTBEAT_SECONDS = 15
MAX_MODEL_BODY_BYTES = 3 * 1024 * 1024


async def result_events(operation: Awaitable[Any]):
    """Only private heartbeats and one final root-proto payload cross this stream."""
    task = asyncio.create_task(operation)
    try:
        yield "event: ready\ndata: {}\n\n"
        while not task.done():
            done, _ = await asyncio.wait((task,), timeout=HEARTBEAT_SECONDS)
            if not done:
                yield "event: heartbeat\ndata: {}\n\n"
        try:
            value = to_wire(await task)
        except RpcError as error:
            yield "event: error\ndata: " + json.dumps(status_body(error)) + "\n\n"
            return
        yield (
            "event: result\ndata: "
            + json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            + "\n\n"
        )
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def install_model_routes(
    app: FastAPI, executor: ModelExecutor, monitor: InferenceMonitor
) -> None:
    from codex_gateway.app import (
        PRIVATE_HEADERS,
        _json,
        authorized_home,
        request_bytes,
    )

    async def monitored_generate(message: GenerateRequest, home):
        config = message.config or (await executor.get(message.conversation)).config
        effort = config.parameters.effort if config.parameters else ""
        answer = None

        async def run(_request, _home):
            nonlocal answer
            answer = await executor.generate(message, home)
            reason = answer.error.reason if answer.error else ""
            error = {
                "MODEL_AUTH": "codex_auth",
                "MODEL_QUOTA": "codex_quota",
                "MODEL_TIMEOUT": "codex_timeout",
                "MODEL_INVALID_ANSWER": "codex_bad_answer",
            }.get(reason, "codex_unavailable" if reason else "")
            return RunInferenceResponse(
                model=MODEL_MAP[config.model],
                effort=effort,
                error_code=error,
                usage_available=answer.usage.available,
                input_tokens=answer.usage.input_tokens,
                output_tokens=answer.usage.output_tokens,
            )

        await monitor.run(
            RunInferenceRequest(model=MODEL_MAP[config.model]),
            home,
            run,
            effort=effort or "default",
        )
        return answer

    async def invoke(request: Request):
        home = await authorized_home(request)
        binding = request.scope["model_binding"]
        try:
            body = (
                None
                if request.method == "GET"
                else _json(await request_bytes(request, max_bytes=MAX_MODEL_BODY_BYTES))
            )
            message = decode_request(
                binding,
                request.url.path.replace("/api/codex/v1/model/", "/api/model/v1/", 1),
                request.query_params.multi_items(),
                body,
            )
        except (UnicodeError, ValueError, WireJsonError, RecursionError):
            raise RpcError(
                "INVALID_ARGUMENT", "INVALID_MODEL_REQUEST", "Invalid model request"
            ) from None
        if isinstance(message, ListModelsRequest):
            return JSONResponse(to_wire(executor.catalog()), headers=PRIVATE_HEADERS)
        if isinstance(message, GenerateRequest):
            # Validate before streaming so malformed calls retain normal RPC errors.
            executor.validate_generate(message)
            operation = monitored_generate(message, home)
        elif isinstance(message, CreateConversationRequest):
            executor.validate_create(message)
            operation = executor.create(message, home)
        elif isinstance(message, GetConversationRequest):
            operation = executor.get(message.name)
        elif isinstance(message, CloseConversationRequest):
            operation = executor.close(message.name, message.request_id)
        else:
            raise RpcError(
                "UNIMPLEMENTED", "MODEL_METHOD_UNSUPPORTED", "Model method unsupported"
            )
        if isinstance(message, (GenerateRequest, CreateConversationRequest)) and (
            "text/event-stream" in request.headers.get("accept", "")
        ):
            return StreamingResponse(
                result_events(operation),
                media_type="text/event-stream",
                headers={**PRIVATE_HEADERS, "x-accel-buffering": "no"},
            )
        return JSONResponse(to_wire(await operation), headers=PRIVATE_HEADERS)

    def bind_route(binding):
        async def route(request: Request):
            request.scope["model_binding"] = binding
            return await invoke(request)

        return route

    for binding in HTTP_BINDINGS:
        if binding.service != "modelrouter.inference.v1.ModelService":
            continue
        path = binding.path_template.replace(
            "{name=conversations/*}", "conversations/{conversation_id}"
        )
        app.add_api_route(path, bind_route(binding), methods=[binding.method])
        app.add_api_route(
            path.replace("/api/model/v1/", "/api/codex/v1/model/", 1),
            bind_route(binding),
            methods=[binding.method],
        )
