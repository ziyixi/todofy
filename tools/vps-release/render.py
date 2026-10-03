"""Render standard Kustomize manifests with exact, verified release identities."""

import json
import re
import subprocess
from pathlib import Path

import tomllib
import yaml
from release_identity import release_id


def render(root: Path, sha: str, images: dict[str, str]) -> dict:
    """Only public identity fields change; resource definitions remain reviewable YAML."""
    profile = tomllib.loads((root / "config/cloud.toml").read_text())
    owner = profile["repository"].split("/")[0]
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or set(images) != {
        "newsletter",
        "platform",
    }:
        raise ValueError("Invalid release identity")
    for service, image in images.items():
        expected = (
            rf"ghcr\.io/{re.escape(owner)}/todofy-{service}@sha256:[0-9a-f]{{64}}"
        )
        if not re.fullmatch(expected, image):
            raise ValueError("Invalid verified image")
    raw = subprocess.check_output(
        ["kubectl", "kustomize", str(root / "platform/k3s/newsletter")],
        text=True,
    )
    items = list(yaml.safe_load_all(raw))
    expected_names = {
        ("Deployment", "newsletter"),
        ("Deployment", "newsletter-config-sync"),
        ("Deployment", "platform-runtime"),
        ("Service", "newsletter"),
        ("Service", "platform-runtime"),
        ("CronJob", "newsletter-daily"),
        ("CronJob", "platform-observer"),
        ("ConfigMap", "newsletter-release"),
        ("ConfigMap", "platform-release"),
        ("ConfigMap", "platform-runtime-config"),
    }
    actual = {(item["kind"], item["metadata"]["name"]) for item in items}
    if actual != expected_names or len(items) != len(expected_names):
        raise ValueError("Unexpected runtime resources")
    identity = release_id(sha)
    for resource in items:
        resource["metadata"]["namespace"] = profile["vps"]["namespace"]
        name = resource["metadata"]["name"]
        if resource["kind"] == "ConfigMap":
            resource["data"] = _config_map(name, profile, sha, images, identity)
        elif resource["kind"] in {"Deployment", "CronJob"}:
            service = "platform" if name.startswith("platform-") else "newsletter"
            template = resource["spec"]
            if resource["kind"] == "CronJob":
                template = template["jobTemplate"]["spec"]
            pod = template["template"]
            pod.setdefault("metadata", {}).setdefault("annotations", {}).update(
                {
                    "personal-cloud/source-sha": sha,
                    "personal-cloud/image-digest": images[service].split("@")[1],
                    "personal-cloud/request-id": identity,
                }
            )
            for container in pod["spec"]["containers"]:
                container["image"] = images[service]
                _variables(container.get("env", []), profile, sha, identity)
    return {"apiVersion": "v1", "kind": "List", "items": items}


def _variables(variables: list, profile: dict, sha: str, identity: str) -> None:
    for variable in variables:
        key = variable["name"]
        if key == "NEWSLETTER_BOOTSTRAP_DRAIN_KEY":
            variable["value"] = "release-" + sha
        elif key in {"NEWSLETTER_RELEASE_REQUEST_ID", "PLATFORM_RELEASE_REQUEST_ID"}:
            variable["value"] = identity
        elif key == "NEWSLETTER_CONFIG_REPOSITORY":
            variable["value"] = profile["repository"]
        elif key == "FLEET_HOST_KEY":
            variable["value"] = profile["vps"]["observer_node_key"]


def _config_map(
    name: str, profile: dict, sha: str, images: dict, identity: str
) -> dict:
    if name != "platform-runtime-config":
        service = "platform" if name == "platform-release" else "newsletter"
        return {
            "request_id": identity,
            "source_sha": sha,
            "image": images[service],
            "phase": "applying",
        }
    config = {
        "version": 1,
        "node_key": profile["vps"]["observer_node_key"],
        "namespace": profile["vps"]["namespace"],
        "repository": profile["repository"],
        "workloads": [
            {
                "workload_key": "newsletter",
                "deployment": "newsletter",
                "container": "newsletter",
                "release_configmap": "newsletter-release",
                "adapter": "newsletter",
            },
            {
                "workload_key": "platform-runtime",
                "deployment": "platform-runtime",
                "container": "platform-runtime",
                "release_configmap": "platform-release",
                "adapter": "personal-cloud",
            },
        ],
    }
    return {"runtime.json": json.dumps(config, sort_keys=True, indent=2)}
