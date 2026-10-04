"""Actions actively compares, repairs or explicitly resumes the accepted immutable runtime."""

import argparse
import json
import os
import re
from pathlib import Path
from uuid import uuid4

from deploy import Deployment, verified_snapshot
from evidence import write_evidence
from release_identity import load_profile
from transport import ReleaseFailure, Transport
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api

ROOT = Path(__file__).resolve().parents[2]
UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)


def frozen(client, release, name):
    targets = release.targets
    if (
        len(targets) != 2
        or {x.workload_key for x in targets} != {"newsletter", "platform-runtime"}
        or len({x.source_sha for x in targets}) != 1
        or any(
            x.request_id != release.request_id or x.generation is not None
            for x in targets
        )
    ):
        raise ReleaseFailure("RELEASE_ACKNOWLEDGEMENT_INVALID")
    client.validate(release, name, targets)
    return targets


def observe(client, release, name, targets, source_name, deadline, evidence_file):
    while True:
        client.validate(release, name, targets)
        if release.source_release != source_name:
            raise ReleaseFailure("RELEASE_ACKNOWLEDGEMENT_INVALID")
        if release.phase in {"held", "failed"}:
            raise ReleaseFailure(release.error_code or "RELEASE_HELD")
        if release.phase == "ready":
            node = client.call(
                "GetNodeStatus", api.GetNodeStatusRequest(name="nodeStatus"), deadline
            )
            if verified_snapshot(node, targets, name, client.now()):
                if evidence_file is not None:
                    write_evidence(evidence_file, release)
                return {
                    "result": "repaired",
                    "release": name,
                    "source_release": source_name,
                    "source_sha": targets[0].source_sha,
                    "state": "ready",
                }
        if client.monotonic() >= deadline:
            raise ReleaseFailure("RELEASE_OBSERVATION_TIMEOUT")
        client.wait(deadline)
        release = client.call("GetRelease", api.GetReleaseRequest(name=name), deadline)


def execute(
    client: Deployment,
    operation: str,
    request_id: str,
    timeout=1800,
    *,
    evidence_file=None,
    release_name=None,
):
    deadline = client.monotonic() + timeout
    if operation == "resume":
        if (
            not isinstance(release_name, str)
            or not release_name.startswith("releases/")
            or not UUID.fullmatch(release_name[9:])
        ):
            raise ReleaseFailure("INVALID_RECONCILIATION_RELEASE")
        release = client.call(
            "GetRelease", api.GetReleaseRequest(name=release_name), deadline
        )
        targets = frozen(client, release, release_name)
        if not release.source_release:
            raise ReleaseFailure("RECONCILIATION_RELEASE_REQUIRED")
        source_name = release.source_release
        if release.phase in {"held", "failed"}:
            release = client.call(
                "ResumeRelease",
                api.ResumeReleaseRequest(
                    name=release_name, etag=release.etag, request_id=request_id
                ),
                deadline,
            )
        return observe(
            client, release, release_name, targets, source_name, deadline, evidence_file
        )
    plan = client.call(
        "GetReconcilePlan", api.GetReconcilePlanRequest(name="reconcilePlan"), deadline
    )
    summary = {
        "state": plan.state,
        "changes": [
            {
                "resource_key": x.resource_key,
                "action": x.action,
                "reason_code": x.reason_code,
            }
            for x in plan.changes
        ],
    }
    if plan.base_release:
        summary["base_release"] = plan.base_release
    if plan.reason_code:
        summary["reason_code"] = plan.reason_code
    if operation == "plan":
        return summary
    if plan.state not in {"clean", "repairable"}:
        raise ReleaseFailure(plan.reason_code or "RECONCILE_MANUAL_REQUIRED")
    if plan.state == "clean":
        return {**summary, "result": "no_change"}
    source = client.call(
        "GetRelease", api.GetReleaseRequest(name=plan.base_release), deadline
    )
    originals = frozen(client, source, plan.base_release)
    if source.phase != "ready" or source.etag != plan.base_etag:
        raise ReleaseFailure("RECONCILE_PLAN_CHANGED")
    release = client.call(
        "ReconcileRelease",
        api.ReconcileReleaseRequest(
            name=plan.base_release,
            etag=plan.base_etag,
            fingerprint=plan.fingerprint,
            request_id=request_id,
        ),
        deadline,
    )
    if release.name == source.name:
        return {**summary, "result": "no_change"}
    targets = tuple(
        type(x)(
            workload_key=x.workload_key,
            source_sha=x.source_sha,
            image_digest=x.image_digest,
            request_id=request_id,
        )
        for x in originals
    )
    return observe(
        client,
        release,
        "releases/" + request_id,
        targets,
        source.name,
        deadline,
        evidence_file,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--operation", choices=("plan", "repair", "resume"), required=True
    )
    parser.add_argument("--request-id", default=None)
    parser.add_argument("--release-name")
    parser.add_argument("--evidence-file", type=Path)
    args = parser.parse_args()
    request_id = args.request_id or str(uuid4())
    transport = None
    try:
        if not UUID.fullmatch(request_id):
            raise ReleaseFailure("INVALID_RECONCILIATION_IDENTITY")
        if args.operation != "resume" and args.release_name is not None:
            raise ReleaseFailure("UNEXPECTED_RECONCILIATION_RELEASE")
        profile = load_profile(ROOT)
        credentials = {
            name: os.environ.get(name, "")
            for name in (
                "PLATFORM_ACCESS_CLIENT_ID",
                "PLATFORM_ACCESS_CLIENT_SECRET",
                "PLATFORM_DEPLOY_TOKEN",
            )
        }
        transport = Transport(profile["vps"]["platform_runtime_host"], credentials)
        result = execute(
            Deployment(transport),
            args.operation,
            request_id,
            evidence_file=args.evidence_file,
            release_name=args.release_name,
        )
        print(json.dumps({"event": "vps_reconcile", **result}, separators=(",", ":")))
        return 0
    except (ReleaseFailure, ValueError, OSError) as error:
        code = (
            str(error)
            if isinstance(error, ReleaseFailure)
            else "INVALID_RECONCILIATION_INPUT"
        )
        print(
            json.dumps(
                {"event": "vps_reconcile", "status": "failed", "error_code": code}
            )
        )
        return 1
    finally:
        if transport is not None:
            transport.close()


if __name__ == "__main__":
    raise SystemExit(main())
