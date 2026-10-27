"""Authenticated, bounded HTTP transport for the generated inference contract."""

import hmac
import json
import os
import pathlib
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from ziyixi_proto.codex.inference.v1.inference_pb import (
    HTTP_BINDINGS,
    CheckInferenceRequest,
    CheckInferenceResponse,
    RunInferenceRequest,
    RunInferenceResponse,
)
from ziyixi_proto.http_routes import decode_request
from ziyixi_proto.rpc_status import RpcError, status_body
from ziyixi_proto.wire_json import WireJsonError, to_wire

from codex_gateway.monitoring import InferenceMonitor, utc_now
from codex_gateway.runtime import check_runtime, infer

MAX_BODY_BYTES = 768 * 1024
BUILD_INFO_FILE = pathlib.Path(__file__).with_name("build-info.json")
PRIVATE_HEADERS = {"cache-control": "no-store", "x-content-type-options": "nosniff"}
Runner = Callable[[RunInferenceRequest, pathlib.Path], Awaitable[RunInferenceResponse]]
Checker = Callable[[pathlib.Path], Awaitable[CheckInferenceResponse]]


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


def _constant(_: str) -> None:
    raise ValueError("invalid JSON number")


def _json(raw: str | bytes) -> Any:
    return json.loads(raw, object_pairs_hook=_object, parse_constant=_constant)


def _baked_source_sha() -> str | None:
    try:
        value = json.loads(BUILD_INFO_FILE.read_text())
    except (OSError, ValueError):
        return None
    sha = value.get("source_sha") if isinstance(value, dict) else None
    return sha if isinstance(sha, str) and re.fullmatch(r"[a-f0-9]{40}", sha) else None


def authorized_home(request: Request) -> pathlib.Path:
    token = os.getenv("CODEX_GATEWAY_TOKEN", "").strip()
    if not token:
        raise RpcError(
            "UNAVAILABLE", "GATEWAY_NOT_CONFIGURED", "Inference is not configured"
        )
    headers = request.headers.getlist("authorization")
    if len(headers) != 1 or not hmac.compare_digest(
        headers[0].encode(), ("Bearer " + token).encode()
    ):
        raise RpcError(
            "UNAUTHENTICATED",
            "INFERENCE_NOT_AUTHORIZED",
            "Inference authorization required",
        )
    home = os.getenv("CODEX_HOME", "")
    if (
        not home
        or not pathlib.Path(home).is_absolute()
        or not pathlib.Path(home).is_dir()
    ):
        raise RpcError(
            "UNAVAILABLE", "GATEWAY_NOT_CONFIGURED", "Inference is not configured"
        )
    return pathlib.Path(home)


async def request_bytes(
    request: Request,
    *,
    reason: str = "INVALID_MODEL_REQUEST",
    max_bytes: int = MAX_BODY_BYTES,
) -> bytes:
    if (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise RpcError("INVALID_ARGUMENT", reason, "Use application/json")
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > max_bytes:
            raise RpcError(
                "INVALID_ARGUMENT",
                reason,
                "Inference request exceeds limit",
            )
        raw.extend(chunk)
    return bytes(raw)


def create_app(
    *,
    monitor_db: pathlib.Path,
    runner: Runner = infer,
    checker: Checker = check_runtime,
    clock: Callable[[], datetime] = utc_now,
    monotonic: Callable[[], float] = time.monotonic,
    model_executor: Any = None,
) -> FastAPI:
    from codex_gateway.model_api import install_model_routes
    from codex_gateway.modelrouter import ModelExecutor

    executor = model_executor or ModelExecutor(monitor_db)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            yield
        finally:
            await executor.shutdown()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    bindings = {item.path_template: item for item in HTTP_BINDINGS}
    source_sha = _baked_source_sha()
    monitor = InferenceMonitor(monitor_db, clock=clock, monotonic=monotonic)

    @app.exception_handler(RpcError)
    async def rpc_error(_request: Request, error: RpcError) -> JSONResponse:
        return JSONResponse(
            status_body(error), status_code=error.http_status, headers=PRIVATE_HEADERS
        )

    @app.get("/healthz")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "service": "codex-gateway",
                "status": "ok",
                "source_sha": source_sha,
                "release_request_id": os.getenv("CODEX_GATEWAY_RELEASE_REQUEST_ID", ""),
                "inference_status": to_wire(monitor.snapshot()),
            },
            headers=PRIVATE_HEADERS,
        )

    async def run(request: Request) -> JSONResponse:
        binding = bindings[request.url.path]
        home = authorized_home(request)
        try:
            decoded = _json(
                await request_bytes(request, reason="INVALID_INFERENCE_REQUEST")
            )
            message = decode_request(
                binding, request.url.path, request.query_params.multi_items(), decoded
            )
            if isinstance(message, RunInferenceRequest):
                if not message.instructions.strip():
                    raise ValueError("invalid inference request")
                _json(message.input_json)
                if not isinstance(_json(message.output_schema_json), dict):
                    raise ValueError("schema must be an object")
            elif not isinstance(message, CheckInferenceRequest):
                raise ValueError("invalid inference request")
        except (UnicodeError, ValueError, WireJsonError, RecursionError):
            raise RpcError(
                "INVALID_ARGUMENT",
                "INVALID_INFERENCE_REQUEST",
                "Invalid inference request",
            ) from None
        if isinstance(message, RunInferenceRequest):
            answer = await monitor.run(message, home, runner)
        else:
            answer = await checker(home)
        return JSONResponse(to_wire(answer), headers=PRIVATE_HEADERS)

    for binding in HTTP_BINDINGS:
        app.add_api_route(binding.path_template, run, methods=[binding.method])
    install_model_routes(app, executor, monitor)
    return app
