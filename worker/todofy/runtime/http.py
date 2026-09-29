"""Response helpers shared by every route."""

import json
import secrets
from contextvars import ContextVar
from typing import Any

import js
from workers import Response

from todofy.core.api_errors import MESSAGES, ApiError

# The gateway's ID for the request being served (x-todofy-request-id), so the DO's error
# envelopes and logs carry the same ID the gateway logged. Unset in alarms.
REQUEST_ID: ContextVar[str | None] = ContextVar("request_id", default=None)


def json_response(data: Any, status: int = 200) -> Response:
    return Response(
        json.dumps(data, ensure_ascii=False),
        status=status,
        headers={
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        },
    )


def error(status: int, code: ApiError) -> Response:
    """The OpenAPI error envelope; the request_id is logged so the owner can quote it."""
    request_id = REQUEST_ID.get() or secrets.token_hex(8)
    print(json.dumps({"request_id": request_id, "status": status, "code": code}))
    return json_response({"error": {"code": code, "message": MESSAGES[code], "request_id": request_id}}, status)


def empty(status: int = 204) -> Response:
    return Response(None, status=status)


def with_headers(response: Response, headers: dict[str, str]) -> Response:
    """Copy a (possibly immutable) response and set extra headers on the copy."""
    copy = js.Response.new(response.js_object.body, response.js_object)
    for name, value in headers.items():
        copy.headers.set(name, value)
    return Response(copy)
