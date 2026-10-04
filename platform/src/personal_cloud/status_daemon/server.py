"""FastAPI transport for the generated runtime API and authenticated release controller."""

import asyncio
import base64
import os
import re
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from urllib.parse import parse_qsl, urlsplit

import uvicorn
from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse
from ziyixi_proto.common.errors.v1.errors_pb import CommonReason
from ziyixi_proto.http_routes import decode_json_body, decode_request, match_path
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.platform.runtime.v1.errors_pb import ErrorReason
from ziyixi_proto.rpc_status import RpcError, status_body
from ziyixi_proto.wire_json import WireJsonError, to_wire

from .config import configuration
from .reader import CA_FILE, TOKEN_FILE, Reader, ReadError

CACHE_SECONDS = 30
MAX_STALENESS_SECONDS = 60
MAX_BODY_BYTES = 16 * 1024


def _error(code, reason, message, **options):
    return RpcError(
        code, reason.name, message, domain="platform.ziyixi.science", **options
    )


class Cache:
    def __init__(self, reader, *, clock=time.monotonic):
        self.reader, self.clock = reader, clock
        self.value, self.observed = None, None
        self.lock = threading.Lock()

    def invalidate(self):
        with self.lock:
            self.value, self.observed = None, None

    def get(self):
        with self.lock:
            if self.value is not None and self.clock() - self.observed < CACHE_SECONDS:
                return self.value
            try:
                value = self.reader.collect()
            except ReadError:
                if (
                    self.value is not None
                    and self.clock() - self.observed <= MAX_STALENESS_SECONDS
                ):
                    return self.value
                raise _error(
                    "UNAVAILABLE",
                    CommonReason.UNAVAILABLE,
                    "Runtime observation is unavailable.",
                ) from None
            self.value, self.observed = value, self.clock()
            return value


def _token(offset: int) -> str:
    return base64.urlsafe_b64encode(("v1:" + str(offset)).encode()).decode().rstrip("=")


def _offset(token: str, total: int) -> int:
    if not token:
        return 0
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("ascii")
        if not re.fullmatch(r"v1:[1-9][0-9]*", raw):
            raise ValueError()
        offset = int(raw[3:])
        if offset >= total or _token(offset) != token:
            raise ValueError()
        return offset
    except (ValueError, UnicodeError):
        raise _error(
            "INVALID_ARGUMENT", CommonReason.BAD_REQUEST, "The page token is invalid."
        ) from None


class Service:
    def __init__(self, cache: Cache, keys: tuple[str, ...]):
        self.cache, self.keys = cache, keys
        self.summary = None
        self.plan = None

    def snapshot(self):
        return self.cache.get()

    def handles(self, target: str) -> bool:
        path = urlsplit(target).path
        return any(
            match_path(binding, path) is not None
            for binding in api.HTTP_BINDINGS
            if binding.method == "GET"
            and binding.rpc in {"GetNodeStatus", "GetWorkload", "ListWorkloads"}
        )

    def get(self, target: str):
        parsed = urlsplit(target)
        if parsed.fragment or len(parsed.query) > 2048:
            raise _error(
                "INVALID_ARGUMENT",
                CommonReason.BAD_REQUEST,
                "The request query is invalid.",
            )
        for binding in api.HTTP_BINDINGS:
            if binding.method != "GET" or binding.rpc not in {
                "GetNodeStatus",
                "GetWorkload",
                "ListWorkloads",
            }:
                continue
            try:
                match = match_path(binding, parsed.path)
                if match is None:
                    continue
                request = decode_request(
                    binding,
                    parsed.path,
                    parse_qsl(
                        parsed.query,
                        keep_blank_values=True,
                        errors="strict",
                        max_num_fields=8,
                    ),
                )
            except (WireJsonError, ValueError):
                raise _error(
                    "INVALID_ARGUMENT",
                    CommonReason.BAD_REQUEST,
                    "The request query is invalid.",
                ) from None
            if binding.rpc == "GetWorkload":
                # Unknown aliases cannot initiate Kubernetes discovery or any provider read.
                key = request.name.split("/", 1)[1]
                if key not in self.keys:
                    raise _error(
                        "NOT_FOUND",
                        ErrorReason.WORKLOAD_NOT_FOUND,
                        "The configured workload was not found.",
                    )
                return next(
                    value
                    for value in self.cache.get().workloads
                    if value.workload_key == key
                )
            if binding.rpc == "GetNodeStatus":
                value = self.snapshot()
                if self.summary is not None:
                    value = replace(value, current_release=self.summary())
                return (
                    replace(value, reconcile_plan=self.plan())
                    if self.plan is not None
                    else value
                )
            if binding.rpc == "ListWorkloads":
                offset = _offset(request.page_token, len(self.keys))
                size = request.page_size or 16
                values = self.cache.get().workloads
                end = min(offset + size, len(values))
                return api.ListWorkloadsResponse(
                    workloads=values[offset:end],
                    next_page_token=_token(end) if end < len(values) else "",
                )
            raise _error(
                "UNIMPLEMENTED",
                CommonReason.METHOD_NOT_ALLOWED,
                "The read method is not implemented.",
            )
        raise _error(
            "NOT_FOUND", CommonReason.NOT_FOUND, "The requested resource was not found."
        )


async def _read_body(request: Request) -> bytes:
    """Read only after machine authorization, with a bounded stream and deadline."""
    lengths = request.headers.getlist("content-length")
    if (
        len(lengths) > 1
        or (lengths and not re.fullmatch(r"[0-9]{1,6}", lengths[0]))
        or (lengths and not 0 < int(lengths[0]) <= MAX_BODY_BYTES)
        or request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise _error(
            "INVALID_ARGUMENT",
            CommonReason.BAD_REQUEST,
            "The release request body is invalid.",
        )
    raw = bytearray()
    try:
        async with asyncio.timeout(5):
            async for chunk in request.stream():
                if len(raw) + len(chunk) > MAX_BODY_BYTES:
                    raise ValueError()
                raw.extend(chunk)
        if lengths and len(raw) != int(lengths[0]):
            raise ValueError()
    except (ValueError, TimeoutError, ClientDisconnect):
        raise _error(
            "INVALID_ARGUMENT",
            CommonReason.BAD_REQUEST,
            "The release request body is invalid.",
        ) from None
    return bytes(raw)


def _body_parser(raw: bytes):
    def read_body():
        try:
            return decode_json_body(raw, max_bytes=MAX_BODY_BYTES)
        except ValueError:
            raise _error(
                "INVALID_ARGUMENT",
                CommonReason.BAD_REQUEST,
                "The release request body is invalid.",
            ) from None

    return read_body


def _target(request: Request) -> str:
    try:
        # Generated routing sees the original escaping, not an ASGI-decoded path that might turn
        # a percent-encoded separator into a different resource name.
        path = request.scope["raw_path"].decode("ascii")
        query = request.scope["query_string"].decode("ascii")
        if len(path) > 2048 or len(query) > 2048:
            raise ValueError()
        return path + ("?" + query if query else "")
    except (UnicodeError, ValueError):
        raise _error(
            "INVALID_ARGUMENT",
            CommonReason.BAD_REQUEST,
            "The request target is invalid.",
        ) from None


def create_app(service: Service, router=None) -> FastAPI:
    """The proto bindings own schema/routing; FastAPI supplies transport and lifecycle only."""

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            try:
                if router is not None:
                    await run_in_threadpool(router.close)
            finally:
                close = getattr(service.cache.reader, "close", None)
                if close is not None:
                    await run_in_threadpool(close)

    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.api_route(
        "/{path:path}",
        methods=[
            "GET",
            "POST",
            "HEAD",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "TRACE",
            "CONNECT",
        ],
        include_in_schema=False,
    )
    async def dispatch(request: Request):
        try:
            target = _target(request)
            if request.method == "GET" and service.handles(target):
                code, value = 200, to_wire(await run_in_threadpool(service.get, target))
            elif router is not None and request.method in {"GET", "POST"}:

                def no_body():
                    raise _error(
                        "INVALID_ARGUMENT",
                        CommonReason.BAD_REQUEST,
                        "The request does not have a body.",
                    )

                read_body = no_body
                if request.method == "POST":
                    # Authorize before asking ASGI for any bytes. The controller also checks its
                    # credentials before decoding the preloaded body; no unauthenticated parser.
                    await run_in_threadpool(router.authorize, request.headers)
                    read_body = _body_parser(await _read_body(request))
                code, value = await run_in_threadpool(
                    router.handle, request.method, target, request.headers, read_body
                )
            elif request.method == "GET":
                raise _error(
                    "NOT_FOUND",
                    CommonReason.NOT_FOUND,
                    "The requested resource was not found.",
                )
            else:
                raise _error(
                    "UNIMPLEMENTED",
                    CommonReason.METHOD_NOT_ALLOWED,
                    "The request method is not supported.",
                    http_status=405,
                )
        except RpcError as error:
            code, value = error.http_status, status_body(error)
        except Exception:  # noqa: BLE001 — sanitize the API boundary; never log provider exception text.
            # Do not let default tracebacks or raw provider exceptions reach responses or logs.
            error = _error("INTERNAL", CommonReason.INTERNAL, "Runtime status failed.")
            code, value = error.http_status, status_body(error)
        return JSONResponse(
            value,
            status_code=code,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    return app


def main(controller_factory=None):
    try:
        with open(
            os.environ.get(
                "PLATFORM_RUNTIME_CONFIG", "/etc/personal-cloud/runtime.json"
            ),
            encoding="utf-8",
        ) as source:
            config = configuration(source.read(16 * 1024 + 1))
    except (OSError, ValueError):
        return 1
    reader = Reader(
        config,
        os.environ.get("NEWSLETTER_MONITOR_TOKEN", ""),
        os.environ.get("PLATFORM_RELEASE_REQUEST_ID", ""),
        token_file=os.environ.get("KUBERNETES_TOKEN_FILE", TOKEN_FILE),
        ca_file=os.environ.get("KUBERNETES_CA_FILE", CA_FILE),
    )
    service = Service(Cache(reader), tuple(item.key for item in config.workloads))
    if controller_factory is None:
        from ..deployment.router import create_router as controller_factory
    try:
        router = controller_factory(config, service)
    except (OSError, ValueError, sqlite3.Error):
        reader.close()
        return 1
    service.summary = router.summary
    service.plan = router.plan
    uvicorn.run(
        create_app(service, router),
        host="0.0.0.0",
        port=8080,
        access_log=False,
        log_level="warning",
    )
    return 0
