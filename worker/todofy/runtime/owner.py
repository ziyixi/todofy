"""Owner UI and API on TODOFY_PUBLIC_HOST, always behind Cloudflare Access."""

from typing import Any

from workers import Response

from todofy.core.api_errors import ApiError
from todofy.runtime.access_jwt import AccessError, authenticate
from todofy.runtime.config import coordinator
from todofy.runtime.http import PRIVATE_HEADERS, error, json_response, with_headers

SPIKE_EVENT_PREFIX = "/api/v1/spike/events/"


async def _api(request: Any, env: Any, path: str) -> Response:
    if request.method == "GET" and path.startswith(SPIKE_EVENT_PREFIX):
        event_id = path.removeprefix(SPIKE_EVENT_PREFIX)
        row = await env.DB.prepare("SELECT * FROM spike_events WHERE event_id = ?").bind(event_id).first()
        return json_response(dict(row)) if row else error(404, ApiError.NOT_FOUND)
    if request.method == "GET" and path == "/api/v1/spike/coordinator":
        return await coordinator(env).fetch("https://coordinator/state")
    return error(404, ApiError.NOT_FOUND)


async def handle(request: Any, env: Any, path: str) -> Response:
    try:
        await authenticate(request, env)
    except AccessError as exc:
        return with_headers(error(exc.status, exc.code), PRIVATE_HEADERS)
    if path.startswith("/api/"):
        response = await _api(request, env, path)
    else:
        # Unknown paths fall back to index.html (not_found_handling = SPA).
        response = await env.ASSETS.fetch(request)
    return with_headers(response, PRIVATE_HEADERS)
