"""Machine endpoints served on every TODOFY_HOOKS_HOSTS name."""

import hashlib
import hmac
from typing import Any

from pyodide.ffi import JsException
from workers import Response

from todofy.core.api_errors import ApiError
from todofy.core.contract import MAX_EVENT_BYTES
from todofy.runtime import reports
from todofy.runtime.config import coordinator, flag, var
from todofy.runtime.http import error, json_response, with_headers

# Mail Hero backs off on 503 and honours Retry-After; one cron interval.
MAINTENANCE_RETRY_AFTER_S = "600"


def _bearer_ok(request: Any, digests: list[str]) -> bool:
    scheme, _, token = (request.headers.get("authorization") or "").partition(" ")
    if scheme != "Bearer" or not token or " " in token:
        return False
    presented = hashlib.sha256(token.encode()).hexdigest()
    # Compare against every digest so timing does not reveal which one matched.
    matches = [hmac.compare_digest(presented, digest) for digest in digests]
    return any(matches)


async def mail(request: Any, env: Any) -> Response:
    digests = [
        digest
        for name in ("MAIL_WEBHOOK_TOKEN_SHA256", "MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS")
        if (digest := var(env, name).lower())
    ]
    if not digests:
        return error(503, ApiError.NOT_CONFIGURED)
    if not _bearer_ok(request, digests):
        return error(401, ApiError.UNAUTHORIZED)
    if flag(env, "MAINTENANCE_MODE"):
        return with_headers(error(503, ApiError.MAINTENANCE), {"retry-after": MAINTENANCE_RETRY_AFTER_S})
    if (request.headers.get("content-type") or "").split(";")[0].strip().lower() != "application/json":
        return error(415, ApiError.UNSUPPORTED_MEDIA_TYPE)
    # A declared length is checked here; a chunked body is capped while the
    # coordinator reads it.
    length = request.headers.get("content-length") or ""
    if length.isdigit() and int(length) > MAX_EVENT_BYTES:
        return error(413, ApiError.PAYLOAD_TOO_LARGE)
    headers = {"content-type": "application/json"}
    if (key := request.headers.get("idempotency-key")) is not None:
        headers["idempotency-key"] = key
    # Parsing, hashing and D1 writes run in the Durable Object: the Worker
    # handler has 10 ms of CPU on Workers Free, the object has 30 s.
    try:
        return await coordinator(env).fetch(
            "https://coordinator/ingest", method="POST", headers=headers, body=request.body
        )
    except JsException:
        return error(503, ApiError.UNAVAILABLE)


async def handle(request: Any, env: Any, path: str) -> Response:
    match request.method, path:
        case "POST", "/hooks/mail":
            return await mail(request, env)
        case "GET", "/api/summary":
            return await _report(request, env, reports.SUMMARY)
        case "GET", "/api/recommendation":
            return await _report(request, env, reports.RECOMMENDATION)
        case "GET", "/health":
            return json_response({"build": var(env, "BUILD_SHA", "unknown")})
    return error(404, ApiError.NOT_FOUND)


async def _report(request: Any, env: Any, kind: str) -> Response:
    try:
        return await reports.serve(request, env, kind)
    except JsException:
        # D1 failed; the newsletter treats 503 as "try again later".
        return error(503, ApiError.UNAVAILABLE)
