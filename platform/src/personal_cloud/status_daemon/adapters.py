"""Business capabilities remain independent of Kubernetes process readiness."""

import json
from dataclasses import dataclass
from importlib.resources import files

from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb

from .config import _matches


@dataclass(frozen=True)
class Business:
    admission: str = "unknown"
    health: str = "unknown"
    worker_healthy: bool | None = None
    source_sha: str | None = None
    request_id: str | None = None
    active_count: int | None = None
    unknown_count: int | None = None


def baked_source_sha() -> str | None:
    """The image's immutable build metadata, never an environment or ConfigMap source claim."""
    try:
        raw = files("personal_cloud").joinpath("build-info.json").read_text()
        if len(raw) > 1024:
            return None
        value = json.loads(raw)
        sha = value.get("source_sha") if isinstance(value, dict) else None
        return sha if _matches(pb.ReleaseTarget, "source_sha", sha) else None
    except (OSError, ValueError):
        return None


def newsletter(value: dict) -> Business:
    # Upstream is the existing versioned private Newsletter JSON API. Only the generic output uses root proto.
    expected = {
        "version",
        "worker_healthy",
        "drain_state",
        "queued_count",
        "inflight_count",
        "unknown_count",
        "build_source_sha",
        "release_request_id",
    }
    if (
        not isinstance(value, dict)
        or set(value)
        != (
            expected
            | (
                {"unknown_by_kind", "unknown_revision", "latest_delivery"}
                if value.get("version") == 2
                else set()
            )
        )
        or type(value["version"]) is not int
        or value["version"] not in {1, 2}
        or type(value["worker_healthy"]) is not bool
    ):
        return Business()
    counts = [value[key] for key in ("queued_count", "inflight_count", "unknown_count")]
    if any(type(count) is not int or not 0 <= count <= 1000 for count in counts):
        return Business()
    drain = value["drain_state"]
    if not isinstance(drain, str) or drain not in {"active", "draining", "frozen"}:
        return Business()
    healthy = value["worker_healthy"]
    sha, request = value["build_source_sha"], value["release_request_id"]
    return Business(
        admission={"active": "accepting", "draining": "draining", "frozen": "frozen"}[
            drain
        ],
        health="unhealthy" if not healthy else "healthy",
        worker_healthy=healthy,
        source_sha=sha if _matches(pb.ReleaseTarget, "source_sha", sha) else None,
        request_id=request
        if _matches(pb.ReleaseTarget, "request_id", request)
        else None,
        active_count=value["inflight_count"],
        unknown_count=value["unknown_count"],
    )


def local_process(request_id: str) -> Business:
    return Business(
        admission="unsupported",
        health="unsupported",
        worker_healthy=True,
        source_sha=baked_source_sha(),
        request_id=request_id
        if _matches(pb.ReleaseTarget, "request_id", request_id)
        else None,
    )
