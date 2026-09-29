"""The answer every coordinator RPC method returns, and the core's few HTTP responses.

The gateway calls the object over JS RPC (docs/gateway-contract.md §3). A Python
exception reaches it only as an opaque error with a traceback, so expected
outcomes, errors included, travel as a :class:`Result`; the gateway turns it into
the HTTP response and adds the request ID to an error envelope.
"""

import json
import secrets
from dataclasses import dataclass
from typing import Any

from workers import Response

from todofy.core.api_errors import MESSAGES, ApiError

JSON_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
}


@dataclass(frozen=True)
class Result:
    """An HTTP answer as plain data: a 2xx with its JSON text, or an error code."""

    status: int
    # The JSON text of a 200, serialised here so the public bytes stay Python's json.dumps.
    body: str | None = None
    # Set exactly when status >= 400.
    code: ApiError | None = None
    # Seconds until a 429 may be retried (the gateway sends it as Retry-After).
    retry_after: int | None = None

    def wire(self) -> dict[str, Any]:
        """The dict an RPC method returns; the gateway receives it as a plain object (CoreResult)."""
        error = None if self.code is None else {"code": str(self.code), "message": MESSAGES[self.code]}
        return {"status": self.status, "body": self.body, "error": error, "retry_after": self.retry_after}


NO_CONTENT = Result(204)


def ok(data: Any) -> Result:
    return Result(200, json.dumps(data, ensure_ascii=False))


def failed(status: int, code: ApiError, retry_after: int | None = None) -> Result:
    return Result(status, code=code, retry_after=retry_after)


def error_response(status: int, code: ApiError, headers: dict[str, str] | None = None) -> Response:
    """An error envelope as HTTP with a fresh request ID, logged; for the fetch handlers only."""
    request_id = secrets.token_hex(8)
    print(json.dumps({"request_id": request_id, "status": status, "code": code}))
    body = {"error": {"code": code, "message": MESSAGES[code], "request_id": request_id}}
    return Response(json.dumps(body, ensure_ascii=False), status=status, headers=JSON_HEADERS | (headers or {}))


def not_found() -> Response:
    """The answer of both fetch handlers: the core has no HTTP routes, only RPC methods."""
    return error_response(404, ApiError.NOT_FOUND)
