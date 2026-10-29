"""Content-free process and deployment health for one read-only identity."""

from collections.abc import Callable
import math
import pathlib
import re
import secrets
from typing import cast

import fastapi
import fastapi.responses as responses

import newsletter.config_sync as config_sync
import newsletter.monitoring_status as monitoring
import newsletter.provenance as provenance
import newsletter.store as storage

_CONFIG_IDENTITIES = {
    "active_revision": re.compile(r"(?:[0-9a-f]{40}|packaged)\Z"),
    "active_digest": config_sync.DIGEST,
    "wanted_revision": re.compile(r"(?:[0-9a-f]{40}|packaged)\Z"),
    "wanted_digest": config_sync.DIGEST,
    "wanted_commit": config_sync.COMMIT,
    "pinned_digest": config_sync.DIGEST,
    "error": re.compile(r"CONFIG_[A-Z_]{1,80}\Z"),
}
_CONFIG_TIMES = ("last_attempt", "last_success")


def _config_status(root: pathlib.Path | None) -> dict[str, object] | None:
    if root is None:
        return None
    empty = dict.fromkeys((*_CONFIG_IDENTITIES, *_CONFIG_TIMES))
    try:
        observed = config_sync.ConfigSync(
            config_sync.SyncSettings(root)
        ).status()
        result = {key: observed.get(key) for key in empty}
        for key, pattern in _CONFIG_IDENTITIES.items():
            value = result[key]
            if value is not None and (
                not isinstance(value, str) or not pattern.fullmatch(value)
            ):
                raise ValueError
        for key in _CONFIG_TIMES:
            value = result[key]
            if value is not None and (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or value < 0
            ):
                raise ValueError
        return result
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        return {**empty, "error": "CONFIG_STATUS_UNAVAILABLE"}


def register(
    app: fastapi.FastAPI,
    token: str,
    healthy: Callable[[], bool],
    *,
    content_config_dir: pathlib.Path | None = None,
) -> None:
    """Expose safe observations without authority to trigger or approve work."""
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
                "version": 2,
                **monitoring.snapshot(database),
                "worker_healthy": healthy(),
                "drain_state": state["state"],
                "queued_count": sum(
                    cast(dict[str, int], state["queued"]).values()
                ),
                "inflight_count": sum(
                    cast(dict[str, int], state["inflight"]).values()
                ),
                "unknown_count": sum(
                    cast(dict[str, int], state["unknown"]).values()
                ),
                "build_source_sha": source_sha,
                "release_request_id": request_id,
                "config_sync": _config_status(content_config_dir),
            },
            headers={"Cache-Control": "no-store"},
        )
