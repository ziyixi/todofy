"""Content-free process and deployment health for one read-only identity."""

from collections.abc import Callable
import secrets
from typing import cast

import fastapi
import fastapi.responses as responses

import newsletter.provenance as provenance
import newsletter.store as storage


def register(
    app: fastapi.FastAPI, token: str, healthy: Callable[[], bool]
) -> None:
    """Expose counts only; the monitor cannot trigger or approve any work."""
    source_sha = provenance.build_sha()
    request_id = provenance.release_request_id()

    async def authenticate(request: fastapi.Request) -> None:
        header = request.headers.get("authorization", "")
        candidate = header[7:] if header.startswith("Bearer ") else ""
        if not token or not secrets.compare_digest(
            candidate.encode(), token.encode()
        ):
            raise fastapi.HTTPException(401, "Valid monitor token required")

    @app.get(
        "/internal/monitoring/status",
        dependencies=[fastapi.Depends(authenticate)],
    )
    async def status() -> responses.JSONResponse:
        database = cast(storage.Store, app.state.store)
        state = database.deployment.status()
        return responses.JSONResponse(
            {
                "version": 1,
                "worker_healthy": healthy(),
                "drain_state": state["state"],
                "queued_count": sum(state["queued"].values()),
                "inflight_count": sum(state["inflight"].values()),
                "unknown_count": sum(state["unknown"].values()),
                "build_source_sha": source_sha,
                "release_request_id": request_id,
            },
            headers={"Cache-Control": "no-store"},
        )
