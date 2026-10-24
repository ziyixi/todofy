"""Observe the fixed hourly runner's installed template without claiming execution."""

import re
from datetime import datetime

from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire

from .config import Workload
from .evidence import desired, timestamp


def cronjob(config: Workload, target: dict | None, job: dict | None, at: datetime):
    generation = (job or {}).get("metadata", {}).get("generation")
    if type(generation) is not int or not 1 <= generation < 2**31:
        generation = None
    wanted, phase = desired(config, target, generation)
    spec = (job or {}).get("spec", {})
    job_spec = spec.get("jobTemplate", {}).get("spec", {})
    template = job_spec.get("template", {})
    annotations = template.get("metadata", {}).get("annotations", {})
    containers = template.get("spec", {}).get("containers", [])
    actual = None
    if len(containers) == 1 and containers[0].get("name") == config.container:
        image = containers[0].get("image", "")
        match = re.fullmatch(r"ghcr\.io/[a-z0-9._/-]+@(sha256:[0-9a-f]{64})", image)
        if match and generation is not None:
            try:
                actual = from_wire(
                    pb.ReleaseTarget,
                    {
                        "workload_key": config.key,
                        "source_sha": annotations.get("personal-cloud/source-sha"),
                        "image_digest": match.group(1),
                        "request_id": annotations.get("personal-cloud/request-id"),
                        "generation": generation,
                    },
                    strict=True,
                ).message
            except WireJsonError:
                pass
    enabled = (
        spec.get("schedule") == "0 * * * *"
        and spec.get("timeZone") == "Etc/UTC"
        and spec.get("suspend", False) is False
        and spec.get("concurrencyPolicy") == "Forbid"
        and job_spec.get("backoffLimit") == 0
        and job_spec.get("activeDeadlineSeconds") == 900
    )
    if job is None or target is None:
        state, process = "missing", "missing"
    elif actual is None or wanted is None or phase is None:
        state, process = "unknown", "unknown"
    elif not enabled or actual != wanted:
        state, process = "degraded", "stopped"
    else:
        state, process = "ready" if phase == "activated" else "pending", "stopped"
    active = (job or {}).get("status", {}).get("active")
    count = len(active) if isinstance(active, list) and len(active) <= 1000 else None
    result = pb.WorkloadStatus(
        name="workloads/" + config.key,
        workload_key=config.key,
        process_state=process,
        admission_state="unsupported",
        health_state="unsupported",
        observed_at=timestamp(at),
        active_count=count,
        release=pb.ReleaseStatus(
            state=state,
            desired=wanted,
            actual=actual,
            observed_at=timestamp(at),
            observed_generation=generation,
            observation_scope="template",
        ),
    )
    return from_wire(pb.WorkloadStatus, to_wire(result), strict=True).message
