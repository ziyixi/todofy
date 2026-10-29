"""The owner console's read API (newsletter.ui.v1) on a listener of its own.

A separate application on a separate port from the engine's API (app.py): its
routes are exactly the generated HTTP_BINDINGS, each ``/api/v1/`` served as
``/api/newsletter/v1/``, all GET, and nothing else (no docs, OpenAPI, health
or engine route). Every request is authenticated before anything is decoded or
read: exactly one Access assertion, verified by console_access.py, whatever
address the request came from. A request is then decoded strictly with the
shared route helpers and answered from one read-only snapshot
(console_read.py) in a worker thread, at most two at a time.

Answers are the wire codec's bytes, compact and unescaped, which are the bytes
TypeScript's toWire writes: the console Worker passes them through unparsed
(PreEncoded). Errors are google.rpc.Status bodies with common.errors.v1
reasons and fixed messages; nothing echoes a request, a record or an
exception, and a failure is logged as its class and a hashed reference only.
"""

import asyncio
from collections.abc import Awaitable, Callable
import json
import logging
import re
import sqlite3
from typing import Any

import fastapi
import fastapi.responses as responses
import starlette.exceptions as starlette_exceptions
import starlette.middleware.base as base
import starlette.responses as starlette_responses
import ziyixi_proto.http_routes as http_routes
import ziyixi_proto.newsletter.ui.v1.newsletter_ui_service_pb as service_pb
import ziyixi_proto.rpc_status as rpc_status
import ziyixi_proto.wire_json as wire_json

import newsletter.console_access as console_access
import newsletter.console_read as console_read
import newsletter.diagnostics as diagnostics

_LOGGER = logging.getLogger(__name__)
# Each binding's /api/v1/ is served under this prefix, the path the console's
# Access application and the tunnel rule cover.
PREFIX = "/api/newsletter/v1/"
_BINDING_PREFIX = "/api/v1/"
# The API's ErrorInfo.domain: the service's default_host.
DOMAIN = "news.ziyixi.science"
ASSERTION_HEADER = "cf-access-jwt-assertion"
# Reads in flight at once; each holds one short SQLite snapshot.
MAX_READS = 2
HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}
# A common reason -> its google.rpc code (METHOD_NOT_ALLOWED is sent as 405).
_REASONS = {
    "BAD_REQUEST": "INVALID_ARGUMENT",
    "NOT_FOUND": "NOT_FOUND",
    "UNAVAILABLE": "UNAVAILABLE",
    "NOT_CONFIGURED": "UNAVAILABLE",
    "UNAUTHORIZED": "UNAUTHENTICATED",
    "INTERNAL": "INTERNAL",
    "METHOD_NOT_ALLOWED": "UNIMPLEMENTED",
}
_TEMPLATE = re.compile(r"\{([a-z_]+)=([^{}]+)\}")


def route_path(template: str) -> str:
    """A binding's path template as this listener's route path.

    ``/api/v1/{name=runs/*}`` becomes ``/api/newsletter/v1/runs/{segment0}``;
    the route only selects the binding, and the shared helper matches and
    decodes the path again.
    """
    if not template.startswith(_BINDING_PREFIX):
        raise ValueError("unexpected binding prefix")
    count = 0

    def segments(match: re.Match[str]) -> str:
        nonlocal count
        parts = []
        for part in match[2].split("/"):
            if part == "*":
                part = "{segment" + str(count) + "}"
                count += 1
            parts.append(part)
        return "/".join(parts)

    return PREFIX + _TEMPLATE.sub(segments, template[len(_BINDING_PREFIX) :])


def error_response(reason: str) -> responses.Response:
    """A google.rpc.Status body for one common reason; no detail."""
    code = _REASONS[reason]
    error = rpc_status.RpcError(
        code,
        reason,
        "Newsletter console read failed.",
        domain=DOMAIN,
        http_status=405 if reason == "METHOD_NOT_ALLOWED" else None,
    )
    headers = {"Allow": "GET"} if reason == "METHOD_NOT_ALLOWED" else {}
    return responses.Response(
        json.dumps(rpc_status.status_body(error), separators=(",", ":")),
        status_code=error.http_status,
        media_type="application/json",
        headers=headers,
    )


def encode(message: object) -> bytes:
    """An answer's exact bytes: the wire codec's, compact and unescaped.

    TypeScript's toWire and JSON.stringify write the same bytes for the same
    message, so the console Worker passes them through unparsed.
    """
    return json.dumps(
        wire_json.to_wire(message), ensure_ascii=False, separators=(",", ":")
    ).encode()


def _answer(
    reader: console_read.ConsoleReader, message: object, healthy: bool
) -> bytes:
    # Read and encode off the event loop the engine's server shares: an
    # edition with its chart is the largest answer.
    return encode(_dispatch(reader, message, healthy))


def _dispatch(
    reader: console_read.ConsoleReader, message: object, healthy: bool
) -> Any:
    match message:
        case service_pb.GetOverviewRequest():
            return reader.overview(healthy=healthy)
        case service_pb.ListRunsRequest():
            return reader.list_runs(message)
        case service_pb.GetRunRequest():
            return reader.get_run(message)
        case service_pb.ListModelCallsRequest():
            return reader.list_model_calls(message)
        case service_pb.SummarizeModelUsageRequest():
            return reader.summarize_model_usage(message)
        case service_pb.ListEditionsRequest():
            return reader.list_editions(message)
        case service_pb.GetEditionRequest():
            return reader.get_edition(message)
        case service_pb.GetEditionRenderingRequest():
            return reader.get_edition_rendering(message)
        case service_pb.GetSourceCatalogRequest():
            return reader.get_source_catalog(message)
        case service_pb.GetBackupStatusRequest():
            return reader.get_backup_status(message)
    raise ValueError("unsupported request")


class _Console:
    """Authenticate, decode and answer one binding's requests."""

    def __init__(
        self,
        reader: console_read.ConsoleReader,
        verifier: console_access.ConsoleAccessVerifier | None,
        healthy: Callable[[], bool],
    ) -> None:
        self.reader, self.verifier, self.healthy = reader, verifier, healthy
        self.reads = asyncio.Semaphore(MAX_READS)

    async def refusal(self, request: fastapi.Request) -> str | None:
        """The reason to refuse before decoding anything, or None."""
        if self.verifier is None:
            return "NOT_CONFIGURED"
        assertions = request.headers.getlist(ASSERTION_HEADER)
        if len(assertions) != 1 or not assertions[0]:
            return "UNAUTHORIZED"
        try:
            await asyncio.to_thread(self.verifier.verify, assertions[0])
        except console_access.InvalidAccessTokenError:
            return "UNAUTHORIZED"
        except console_access.AccessKeysUnavailableError:
            return "UNAVAILABLE"
        return None

    async def read(self, message: object) -> bytes:
        """The answer's wire bytes, read in a worker thread."""
        state = self.healthy()
        async with self.reads:
            return await asyncio.to_thread(_answer, self.reader, message, state)

    def endpoint(
        self, binding: http_routes.HttpBinding
    ) -> Callable[[fastapi.Request], Awaitable[responses.Response]]:
        """The route handler of one generated binding."""

        async def answer(request: fastapi.Request) -> responses.Response:
            refused = await self.refusal(request)
            if refused:
                return error_response(refused)
            path = _BINDING_PREFIX + request.url.path[len(PREFIX) :]
            try:
                message = http_routes.decode_request(
                    binding, path, request.query_params.multi_items()
                )
            except (wire_json.WireJsonError, ValueError, RecursionError):
                return error_response("BAD_REQUEST")
            try:
                body = await self.read(message)
            except console_read.ConsoleError as error:
                return error_response(error.reason)
            except sqlite3.OperationalError:
                # A busy or unreadable database: a later read may succeed.
                return error_response("UNAVAILABLE")
            except Exception as error:  # noqa: BLE001
                diagnostics.record_failure(
                    _LOGGER, phase="console_read", error=error
                )
                return error_response("INTERNAL")
            return responses.Response(body, media_type="application/json")

        return answer


def create_console_app(
    reader: console_read.ConsoleReader,
    verifier: console_access.ConsoleAccessVerifier | None,
    healthy: Callable[[], bool],
) -> fastapi.FastAPI:
    """The read-only console listener's application.

    ``verifier`` is None when the image baked no Access policy: every request
    then answers NOT_CONFIGURED, and the engine is unaffected.
    """
    app = fastapi.FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    console = _Console(reader, verifier, healthy)
    for binding in service_pb.HTTP_BINDINGS:
        if binding.method != "GET":
            raise ValueError("the console serves reads only")
        app.add_api_route(
            route_path(binding.path_template),
            console.endpoint(binding),
            methods=["GET"],
            include_in_schema=False,
        )

    async def refused(
        _request: fastapi.Request, error: Exception
    ) -> responses.Response:
        status = getattr(error, "status_code", 404)
        return error_response(
            "METHOD_NOT_ALLOWED" if status == 405 else "NOT_FOUND"
        )

    async def private(
        request: fastapi.Request, call_next: base.RequestResponseEndpoint
    ) -> starlette_responses.Response:
        result = await call_next(request)
        result.headers.update(HEADERS)
        return result

    app.exception_handler(starlette_exceptions.HTTPException)(refused)
    app.middleware("http")(private)
    return app
