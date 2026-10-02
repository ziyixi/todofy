"""Private, bounded JSON deployment control using the existing send identity."""

from collections.abc import Awaitable, Callable
import json
from typing import cast

import fastapi
import fastapi.responses as responses

import newsletter.drain as drain
import newsletter.store as storage


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate deployment field")
        result[key] = value
    return result


async def _key(request: fastapi.Request) -> str:
    if request.headers.get("content-type", "").split(";")[0].strip() != (
        "application/json"
    ):
        raise fastapi.HTTPException(415, "JSON required")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 1024:
            raise fastapi.HTTPException(413, "Deployment body too large")
    try:
        value = json.loads(body, object_pairs_hook=_object)
        if not isinstance(value, dict) or set(value) != {"request_key"}:
            raise ValueError
        key = value["request_key"]
        if not isinstance(key, str):
            raise ValueError
    except (ValueError, UnicodeError, RecursionError):
        raise fastapi.HTTPException(400, "Invalid deployment body") from None
    return key


def register(
    app: fastapi.FastAPI,
    authenticate: Callable[[fastapi.Request], Awaitable[None]],
) -> None:
    """Register only machine controls; no owner UI or provider capabilities."""

    @app.get(
        "/internal/deployment/drain",
        dependencies=[fastapi.Depends(authenticate)],
    )
    async def status() -> responses.JSONResponse:
        store = cast(storage.Store, app.state.store)
        return responses.JSONResponse(store.deployment.status())

    @app.post(
        "/internal/deployment/drain/{action}",
        dependencies=[fastapi.Depends(authenticate)],
    )
    async def control(
        action: str, request: fastapi.Request
    ) -> responses.JSONResponse:
        if action not in {"begin", "freeze", "resume"}:
            raise fastapi.HTTPException(404, "Unknown deployment operation")
        key = await _key(request)
        store = cast(storage.Store, app.state.store)
        result = {
            "begin": store.deployment.begin,
            "freeze": store.deployment.freeze,
            "resume": store.deployment.resume,
        }[action](key)
        if action == "resume":
            app.state.worker.wake.set()
        return responses.JSONResponse(result)


async def known_error(
    _request: fastapi.Request, error: Exception
) -> responses.JSONResponse:
    """Return stable codes without private data or provider bodies."""
    assert isinstance(error, drain.DrainError)
    status = {
        "deployment_draining": 503,
        "deployment_invalid_key": 400,
    }.get(error.code, 409)
    headers = {"Retry-After": "30"} if status == 503 else None
    return responses.JSONResponse(
        {"error": error.code}, status_code=status, headers=headers
    )
