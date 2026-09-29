"""Machine endpoints served on every TODOFY_HOOKS_HOSTS name."""

import hashlib
import hmac
from typing import Any

from workers import Response

from todofy.core.api_errors import ApiError
from todofy.core.contract import MAX_EVENT_BYTES
from todofy.runtime.config import coordinator, var
from todofy.runtime.http import error, json_response


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
    if (request.headers.get("content-type") or "").split(";")[0].strip().lower() != "application/json":
        return error(415, ApiError.UNSUPPORTED_MEDIA_TYPE)
    length = request.headers.get("content-length") or ""
    if not length.isdigit():
        return error(411, ApiError.LENGTH_REQUIRED)
    if int(length) > MAX_EVENT_BYTES:
        return error(413, ApiError.PAYLOAD_TOO_LARGE)
    # Parsing, hashing and D1 writes run in the Durable Object: the Worker
    # handler has 10 ms of CPU on Workers Free, the object has 30 s.
    return await coordinator(env).fetch(
        "https://coordinator/ingest",
        method="POST",
        headers={"content-type": "application/json"},
        body=request.body,
    )


async def handle(request: Any, env: Any, path: str) -> Response:
    match request.method, path:
        case "POST", "/hooks/mail":
            return await mail(request, env)
        case "GET", "/health":
            return json_response({"build": var(env, "BUILD_SHA", "unknown")})
    return error(404, ApiError.NOT_FOUND)
