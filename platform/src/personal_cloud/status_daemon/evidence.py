"""Physical observations and process provenance, independent of desired release claims."""

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from .adapters import Business
from .config import Workload


def timestamp(at: datetime) -> str:
    return (
        at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def _object(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _generation(value: object) -> int | None:
    return value if type(value) is int and 1 <= value < 2**31 else None


def _count(value: object) -> bool:
    return type(value) is int and 0 <= value < 2**31


@dataclass(frozen=True)
class Physical:
    process: str
    complete: bool
    ready: bool
    generation: int | None = None
    observed_generation: int | None = None
    digest: str | None = None


def physical(config: Workload, deployment: dict | None, pods: dict | None) -> Physical:
    if deployment is None:
        return Physical("missing", True, False)
    if pods is None:
        return Physical("unknown", False, False)
    metadata, spec, status = (
        _object(deployment.get(key)) for key in ("metadata", "spec", "status")
    )
    generation, observed = (
        _generation(metadata.get("generation")),
        _generation(status.get("observedGeneration")),
    )
    replicas = [
        status.get(key)
        for key in ("replicas", "readyReplicas", "updatedReplicas", "availableReplicas")
    ]
    desired_replicas = spec.get("replicas")
    containers = _object(_object(spec.get("template")).get("spec")).get("containers")
    values = pods.get("items")
    complete = (
        generation is not None
        and observed is not None
        and _count(desired_replicas)
        and all(_count(value) for value in replicas)
        and isinstance(containers, list)
        and len(containers) == 1
        and isinstance(containers[0], dict)
        and containers[0].get("name") == config.container
        and isinstance(containers[0].get("image"), str)
        and isinstance(values, list)
        and not _object(pods.get("metadata")).get("continue")
    )
    if not complete:
        return Physical("unknown", False, False, generation, observed)
    if desired_replicas == 0:
        return Physical("stopped", True, False, generation, observed)
    if len(values) != 1:
        return Physical("starting", True, False, generation, observed)
    pod = _object(values[0])
    pod_meta, pod_spec, pod_status = (
        _object(pod.get(key)) for key in ("metadata", "spec", "status")
    )
    pod_containers, states, conditions = (
        pod_spec.get("containers"),
        pod_status.get("containerStatuses"),
        pod_status.get("conditions"),
    )
    if (
        not isinstance(pod_containers, list)
        or len(pod_containers) != 1
        or not isinstance(pod_containers[0], dict)
        or not isinstance(states, list)
        or len(states) != 1
        or not isinstance(states[0], dict)
        or not isinstance(conditions, list)
        or not isinstance(pod_status.get("phase"), str)
    ):
        return Physical("unknown", False, False, generation, observed)
    container, state = pod_containers[0], states[0]
    ready_conditions = [
        item
        for item in conditions
        if isinstance(item, dict) and item.get("type") == "Ready"
    ]
    image_id = state.get("imageID")
    if (
        container.get("name") != config.container
        or state.get("name") != config.container
        or not isinstance(container.get("image"), str)
        or type(state.get("ready")) is not bool
        or not isinstance(image_id, str)
        or not image_id
        or len(ready_conditions) != 1
        or not isinstance(ready_conditions[0].get("status"), str)
        or ready_conditions[0].get("status") not in {"True", "False", "Unknown"}
        or not isinstance(state.get("state"), dict)
    ):
        return Physical("unknown", False, False, generation, observed)
    # Manifest identity must come from the running container, not template/annotation claims. Bare containerd
    # config IDs cannot prove a pulled manifest identity. Registry mirror names may differ, the digest cannot.
    match = re.fullmatch(
        r"(?:docker-pullable://)?[a-z0-9][a-z0-9._:/-]*@(sha256:[0-9a-f]{64})", image_id
    )
    digest = match.group(1) if match else None
    actual_spec = re.fullmatch(
        r"[a-z0-9][a-z0-9._:/-]*@(sha256:[0-9a-f]{64})", container["image"]
    )
    ready = (
        observed >= generation
        and desired_replicas == 1
        and replicas == [1, 1, 1, 1]
        and not metadata.get("deletionTimestamp")
        and not pod_meta.get("deletionTimestamp")
        and pod_status["phase"] == "Running"
        and state["ready"]
        and ready_conditions[0]["status"] == "True"
        and isinstance(state["state"].get("running"), dict)
        and container["image"] == containers[0]["image"]
        and actual_spec is not None
        and digest is not None
        and digest == actual_spec.group(1)
    )
    process = (
        "running"
        if ready
        else "stopped"
        if pod_status["phase"] in {"Succeeded", "Failed"}
        else "starting"
    )
    return Physical(process, True, ready, generation, observed, digest)


def desired(
    config: Workload, target: dict | None, generation: int | None
) -> tuple[pb.ReleaseTarget | None, str | None]:
    data = _object(_object(target).get("data"))
    image = data.get("image")
    image_match = (
        re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*@(sha256:[0-9a-f]{64})", image)
        if isinstance(image, str)
        else None
    )
    if image_match is None:
        return None, None
    fields = {
        "workload_key": config.key,
        "source_sha": data.get("source_sha"),
        "image_digest": image_match.group(1),
        "request_id": data.get("request_id"),
    }
    if generation is not None:
        fields["generation"] = generation
    try:
        target_value = from_wire(pb.ReleaseTarget, fields, strict=True).message
    except WireJsonError:
        return None, None
    phase = data.get("phase")
    return target_value, phase if isinstance(phase, str) and phase in {
        "target",
        "applying",
        "activated",
    } else None


def workload(
    config: Workload,
    target: dict | None,
    deployment: dict | None,
    pods: dict | None,
    business: Business,
    at: datetime,
    *,
    unavailable: bool = False,
) -> pb.WorkloadStatus:
    observed = (
        physical(config, deployment, pods)
        if not unavailable
        else Physical("unknown", False, False)
    )
    wanted, phase = desired(config, target, observed.generation)
    actual = None
    if (
        observed.ready
        and business.source_sha is not None
        and business.request_id is not None
    ):
        actual = pb.ReleaseTarget(
            workload_key=config.key,
            source_sha=business.source_sha,
            image_digest=observed.digest,
            request_id=business.request_id,
            generation=observed.observed_generation,
        )
    if unavailable or not observed.complete or wanted is None or phase is None:
        state = (
            "missing"
            if not unavailable and (deployment is None or target is None)
            else "unknown"
        )
    elif phase != "activated":
        state = "pending"
    elif actual is None:
        state = "unknown" if observed.ready else "degraded"
    elif (actual.source_sha, actual.image_digest, actual.request_id) != (
        wanted.source_sha,
        wanted.image_digest,
        wanted.request_id,
    ):
        state = "degraded"
    elif business.worker_healthy is None or business.admission == "unknown":
        state = "unknown"
    elif not business.worker_healthy:
        state = "degraded"
    elif business.admission in {"draining", "frozen"}:
        state = "paused"
    else:
        state = "ready"
    when = timestamp(at)
    result = pb.WorkloadStatus(
        name="workloads/" + config.key,
        workload_key=config.key,
        process_state=observed.process,
        admission_state=business.admission,
        health_state=business.health,
        release=pb.ReleaseStatus(
            state=state,
            desired=wanted,
            actual=actual,
            observed_at=when,
            observed_generation=observed.observed_generation,
        ),
        observed_at=when,
        active_count=business.active_count,
        unknown_count=business.unknown_count,
    )
    # Check producer output with the shared strict profile; omitted observations remain absent, never fake zeros.
    return from_wire(pb.WorkloadStatus, to_wire(result), strict=True).message
