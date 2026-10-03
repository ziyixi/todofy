"""Actions pushes a constrained typed release to the daemon, then verifies observed running identities."""

import argparse
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

from release_identity import release_id, resume_id, verified_images
from transport import ReleaseFailure, TransientFailure, Transport
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as service

ROOT = Path(__file__).resolve().parents[2]
BINDINGS = {binding.rpc: binding for binding in service.HTTP_BINDINGS}


def fresh(value: str, now: datetime) -> bool:
    try:
        age = (now - datetime.fromisoformat(value)).total_seconds()
        return -30 <= age <= 120
    except (TypeError, ValueError):
        return False


def verified_snapshot(
    node: pb.NodeStatus, targets: tuple[pb.ReleaseTarget, ...], name: str, now: datetime
) -> bool:
    """Source labels alone never pass: require independent actual digest/provenance and adapter readiness."""
    if node.state not in {"ready", "degraded"} or not fresh(node.observed_at, now):
        return False
    summary = node.current_release
    if (
        summary is None
        or summary.name != name
        or summary.phase != "ready"
        or summary.request_id != targets[0].request_id
    ):
        return False
    statuses = {item.workload_key: item for item in node.workloads}
    if len(statuses) != len(node.workloads) or set(statuses) != {
        target.workload_key for target in targets
    }:
        return False
    for target in targets:
        item = statuses.get(target.workload_key)
        if (
            item is None
            or item.name != "workloads/" + target.workload_key
            or item.process_state != "running"
            or item.admission_state not in {"accepting", "unsupported"}
            or (
                item.health_state not in {"healthy", "unsupported"}
                and not (
                    item.workload_key == "newsletter"
                    and item.health_state == "degraded"
                    and type(item.unknown_count) is int
                    and item.unknown_count > 0
                )
            )
            or not fresh(item.observed_at, now)
        ):
            return False
        release = item.release
        if (
            release is None
            or release.state != "ready"
            or not fresh(release.observed_at, now)
        ):
            return False
        for evidence in (release.desired, release.actual):
            if evidence is None or any(
                getattr(evidence, key) != getattr(target, key)
                for key in ("workload_key", "source_sha", "image_digest", "request_id")
            ):
                return False
        generation = release.desired.generation
        if generation is not None and (
            release.actual.generation != generation
            or release.observed_generation != generation
        ):
            return False
    return True


class Deployment:
    def __init__(
        self,
        transport: Transport,
        *,
        monotonic=time.monotonic,
        sleep=time.sleep,
        now=lambda: datetime.now(UTC),
    ):
        self.transport, self.monotonic, self.sleep, self.now = (
            transport,
            monotonic,
            sleep,
            now,
        )
        self.business_state = {}

    def call(self, method: str, request: object, deadline: float) -> object:
        while True:
            remaining = deadline - self.monotonic()
            if remaining <= 0:
                raise ReleaseFailure("RELEASE_OBSERVATION_TIMEOUT")
            try:
                result = self.transport.call(
                    BINDINGS[method], request, timeout=min(30, remaining)
                )
            except TransientFailure:
                # Recreate can replace the daemon for minutes. Keep exactly the frozen
                # Create/Resume identity throughout the one overall operation budget.
                self.wait(deadline)
                continue
            if self.monotonic() >= deadline:
                raise ReleaseFailure("RELEASE_OBSERVATION_TIMEOUT")
            return result

    def wait(self, deadline: float) -> None:
        remaining = deadline - self.monotonic()
        if remaining <= 0:
            raise ReleaseFailure("RELEASE_OBSERVATION_TIMEOUT")
        self.sleep(min(5, remaining))

    def execute(
        self,
        sha: str,
        digests: dict[str, str],
        *,
        resume: bool = False,
        timeout: int = 1800,
    ) -> pb.Release:
        if not 30 <= timeout <= 3600 or set(digests) != {
            "newsletter",
            "platform-runtime",
        }:
            raise ReleaseFailure("INVALID_DEPLOYMENT_TIMEOUT")
        deadline = self.monotonic() + timeout
        identity = release_id(sha)
        name = "releases/" + identity
        targets = tuple(
            pb.ReleaseTarget(
                workload_key=key,
                source_sha=sha,
                image_digest=digest,
                request_id=identity,
            )
            for key, digest in sorted(digests.items())
        )
        if resume:
            release = self.call(
                "GetRelease", service.GetReleaseRequest(name=name), deadline
            )
            self.validate(release, name, targets)
            if release.phase in {"held", "failed"}:
                release = self.call(
                    "ResumeRelease",
                    service.ResumeReleaseRequest(
                        name=name,
                        request_id=resume_id(name, release.etag),
                        etag=release.etag,
                    ),
                    deadline,
                )
        else:
            release = self.call(
                "CreateRelease",
                service.CreateReleaseRequest(
                    release_id=identity,
                    request_id=identity,
                    release=pb.Release(targets=targets),
                ),
                deadline,
            )
        while True:
            self.validate(release, name, targets)
            if release.phase in {"held", "failed"}:
                raise ReleaseFailure(release.error_code or "RELEASE_HELD")
            if release.phase == "ready":
                node = self.call(
                    "GetNodeStatus",
                    service.GetNodeStatusRequest(name="nodeStatus"),
                    deadline,
                )
                if verified_snapshot(node, targets, name, self.now()):
                    self.business_state = {
                        item.workload_key: {
                            "health_state": item.health_state,
                            **(
                                {"unknown_count": item.unknown_count}
                                if item.unknown_count is not None
                                else {}
                            ),
                        }
                        for item in node.workloads
                    }
                    return release
            if self.monotonic() >= deadline:
                raise ReleaseFailure("RELEASE_OBSERVATION_TIMEOUT")
            self.wait(deadline)
            release = self.call(
                "GetRelease", service.GetReleaseRequest(name=name), deadline
            )

    @staticmethod
    def validate(
        release: pb.Release, name: str, targets: tuple[pb.ReleaseTarget, ...]
    ) -> None:
        if (
            release.name != name
            or release.request_id != targets[0].request_id
            or not release.phase
            or not release.etag
            or not release.create_time
            or not release.update_time
            or len(release.targets) != len(targets)
        ):
            raise ReleaseFailure("RELEASE_ACKNOWLEDGEMENT_INVALID")
        expected = {target.workload_key: target for target in targets}
        if len({target.workload_key for target in release.targets}) != len(targets):
            raise ReleaseFailure("RELEASE_ACKNOWLEDGEMENT_INVALID")
        for actual in release.targets:
            target = expected.get(actual.workload_key)
            if target is None or actual != target:
                raise ReleaseFailure("RELEASE_ACKNOWLEDGEMENT_INVALID")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--newsletter-image", required=True)
    parser.add_argument("--platform-image", required=True)
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Explicitly continue the same held operation with its current etag",
    )
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()
    transport = None
    try:
        profile, digests = verified_images(
            ROOT,
            args.source_sha,
            {"newsletter": args.newsletter_image, "platform": args.platform_image},
        )
        credentials = {
            name: os.environ.get(name, "")
            for name in (
                "PLATFORM_ACCESS_CLIENT_ID",
                "PLATFORM_ACCESS_CLIENT_SECRET",
                "PLATFORM_DEPLOY_TOKEN",
            )
        }
        transport = Transport(profile["vps"]["platform_runtime_host"], credentials)
        deployment = Deployment(transport)
        release = deployment.execute(
            args.source_sha, digests, resume=args.resume, timeout=args.timeout
        )
        print(
            json.dumps(
                {
                    "release_id": release.name.split("/")[1],
                    "source_sha": args.source_sha,
                    "phase": release.phase,
                    "business_state": deployment.business_state,
                }
            )
        )
        return 0
    except ReleaseFailure as error:
        print(json.dumps({"error_code": str(error)}))
        return 1
    except ValueError:
        print(json.dumps({"error_code": "RELEASE_CONFIGURATION_INVALID"}))
        return 1
    finally:
        if transport is not None:
            transport.close()


if __name__ == "__main__":
    raise SystemExit(main())
