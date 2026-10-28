"""Private transport for the slim generated model contract."""

import asyncio
import contextlib
import json
from collections.abc import Awaitable
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from ziyixi_proto.http_routes import decode_request
from ziyixi_proto.modelrouter.inference.v1.inference_pb import (
    HTTP_BINDINGS,
    CloseConversationRequest,
    CreateConversationRequest,
    GenerateRequest,
    ListModelsRequest,
)
from ziyixi_proto.rpc_status import RpcError, status_body
from ziyixi_proto.wire_json import WireJsonError, to_wire

from codex_gateway.modelrouter import ModelExecutor

HEARTBEAT_SECONDS = 15


def payload(value: Any) -> dict:
    return {} if value is None else to_wire(value)


async def result_events(operation: Awaitable[Any]):
    """Private keepalives and one final result; no token stream is exposed to apps."""
    task = asyncio.create_task(operation)
    try:
        yield "event: ready\ndata: {}\n\n"
        while not task.done():
            done, _ = await asyncio.wait((task,), timeout=HEARTBEAT_SECONDS)
            if not done:
                yield "event: heartbeat\ndata: {}\n\n"
        try:
            value = payload(await task)
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


def install_model_routes(app: FastAPI, executor: ModelExecutor) -> None:
    from codex_gateway.app import PRIVATE_HEADERS, _json, authorized_home, request_bytes

    async def invoke(request: Request):
        home = await authorized_home(request)
        try:
            body = (
                None if request.method == "GET" else _json(await request_bytes(request))
            )
            message = decode_request(
                request.scope["model_binding"],
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
            executor.validate_generate(message)
            operation = executor.generate(message, home)
        elif isinstance(message, CreateConversationRequest):
            executor.validate_create(message)
            operation = executor.create(message, home)
        elif isinstance(message, CloseConversationRequest):
            operation = executor.close(message.name)
        else:
            raise RpcError(
                "UNIMPLEMENTED", "MODEL_METHOD_UNSUPPORTED", "Model method unsupported"
            )
        if isinstance(
            message, (GenerateRequest, CreateConversationRequest)
        ) and "text/event-stream" in request.headers.get("accept", ""):
            return StreamingResponse(
                result_events(operation),
                media_type="text/event-stream",
                headers={**PRIVATE_HEADERS, "x-accel-buffering": "no"},
            )
        return JSONResponse(payload(await operation), headers=PRIVATE_HEADERS)

    def bind_route(binding):
        async def route(request: Request):
            request.scope["model_binding"] = binding
            return await invoke(request)

        return route

    for binding in HTTP_BINDINGS:
        path = binding.path_template.replace(
            "{name=conversations/*}", "conversations/{conversation_id}"
        )
        app.add_api_route(path, bind_route(binding), methods=[binding.method])
        app.add_api_route(
            path.replace("/api/model/v1/", "/api/codex/v1/model/", 1),
            bind_route(binding),
            methods=[binding.method],
        )
