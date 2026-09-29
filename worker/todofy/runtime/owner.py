"""Owner UI and API on TODOFY_PUBLIC_HOST, always behind Cloudflare Access.

The gate, in order: Access JWT on every request (static assets included), then
for API writes the CSRF check and MAINTENANCE_MODE, then the route. Every
response leaves with PRIVATE_HEADERS.
"""

from typing import Any

from pyodide.ffi import JsException
from workers import Response

from todofy.core.api_errors import ApiError
from todofy.runtime import api, csrf
from todofy.runtime.access_jwt import AccessError, authenticate
from todofy.runtime.config import flag
from todofy.runtime.http import PRIVATE_HEADERS, error, with_headers

READ_METHODS = frozenset({"GET", "HEAD"})
MAINTENANCE_RETRY_AFTER_S = "300"


async def _api(request: Any, env: Any, owner: str, path: str) -> Response:
    if request.method not in READ_METHODS:
        await csrf.verify(request, env, owner)
        if flag(env, "MAINTENANCE_MODE"):
            return with_headers(error(503, ApiError.MAINTENANCE), {"retry-after": MAINTENANCE_RETRY_AFTER_S})
    try:
        return await api.handle(request, env, owner, path)
    except JsException:
        # D1, the coordinator or a binding failed; the details stay in the platform logs.
        return error(503, ApiError.UNAVAILABLE)


async def handle(request: Any, env: Any, path: str) -> Response:
    try:
        owner = await authenticate(request, env)
        if path.startswith("/api/"):
            response = await _api(request, env, owner, path)
        else:
            # Unknown paths fall back to index.html (not_found_handling = SPA).
            response = await env.ASSETS.fetch(request)
    except AccessError as exc:
        response = error(exc.status, exc.code)
    return with_headers(response, PRIVATE_HEADERS)
