"""Render standard Kustomize manifests with exact, verified release identities."""

import subprocess
from pathlib import Path

import yaml
from personal_cloud.deployment.resources import Renderer
from personal_cloud.status_daemon.config import Configuration, Workload
from release_identity import release_id, verified_images
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb


def render(root: Path, sha: str, images: dict[str, str]) -> dict:
    """Reuse the daemon renderer; release requests only choose reviewed fixed workloads."""
    profile, digests = verified_images(root, sha, images)
    workloads = [
        Workload(
            "newsletter", "newsletter", "newsletter", "newsletter-release", "newsletter"
        ),
        Workload(
            "platform-runtime",
            "platform-runtime",
            "platform-runtime",
            "platform-release",
            "personal-cloud",
        ),
    ]
    if "codex-gateway" in images:
        workloads.append(
            Workload(
                "codex-gateway",
                "codex-gateway",
                "codex-gateway",
                "codex-gateway-release",
                "codex-gateway",
            )
        )
    config = Configuration(
        profile["vps"]["observer_node_key"],
        profile["vps"]["namespace"],
        tuple(sorted(workloads, key=lambda item: item.key)),
        profile["repository"],
        tuple(profile["vps"]["expected_daemons"]),
    )
    raw = subprocess.check_output(
        ["kubectl", "kustomize", str(root / "platform/k3s/newsletter")],
        text=True,
    )
    renderer = Renderer(
        config,
        asset={
            "apiVersion": "v1",
            "kind": "List",
            "items": list(yaml.safe_load_all(raw)),
        },
    )
    identity = release_id(sha, gateway_only=set(images) == {"codex-gateway"})
    targets = tuple(
        pb.ReleaseTarget(
            workload_key=key, source_sha=sha, image_digest=digest, request_id=identity
        )
        for key, digest in sorted(digests.items())
    )
    items = list(renderer.render(targets, identity))
    for resource in items:
        if (
            resource["kind"] == "ConfigMap"
            and resource["metadata"]["name"] != "platform-runtime-config"
        ):
            resource["data"]["phase"] = "applying"
    return {"apiVersion": "v1", "kind": "List", "items": items}
