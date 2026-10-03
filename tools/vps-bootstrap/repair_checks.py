"""Fixed old bootstrap identity and content-free, read-only repair preconditions."""

import hashlib
import json
import re
import sqlite3
from pathlib import Path
from uuid import UUID

import host

from config import checksum, load_bundle, read_json, require

PREVIOUS_SHA = "54861b2acb2124b27029e8642ccdaca3d45315fe"
PREVIOUS_MANIFEST = "e2517e26f81c0ff4f5b61a100a64b8cf7286b12a6bec74a58628d8ae7226fa55"
RESOURCE_NAMES = {
    ("Deployment", "newsletter"),
    ("Deployment", "newsletter-config-sync"),
    ("Deployment", "platform-runtime"),
    ("CronJob", "newsletter-daily"),
    ("CronJob", "platform-observer"),
    ("Service", "newsletter"),
    ("Service", "platform-runtime"),
    ("ConfigMap", "newsletter-release"),
    ("ConfigMap", "platform-release"),
    ("ConfigMap", "platform-runtime-config"),
}


def identity(sha):
    value = hashlib.sha256(("personal-cloud-release-v1:" + sha).encode()).digest()
    return str(UUID(bytes=value[:16], version=4))


def runtime(directory, public):
    value = read_json(Path(directory) / "runtime.json")
    require(value.get("kind") == "List", "REPAIR_RUNTIME_INVALID")
    items = value.get("items", [])
    require(
        isinstance(items, list)
        and len(items) == len(RESOURCE_NAMES)
        and {(item["kind"], item["metadata"]["name"]) for item in items}
        == RESOURCE_NAMES
        and all(
            item["metadata"].get("namespace") == public["profile"]["namespace"]
            for item in items
        ),
        "REPAIR_RUNTIME_INVALID",
    )
    images = public["images"]
    owner = public["profile"]["repository"].split("/")[0]
    require(set(images) == {"newsletter", "platform"}, "REPAIR_IMAGES_INVALID")
    for service, image in images.items():
        require(
            isinstance(image, str)
            and re.fullmatch(
                rf"ghcr\.io/{re.escape(owner)}/todofy-{service}@sha256:[0-9a-f]{{64}}",
                image,
            ),
            "REPAIR_IMAGES_INVALID",
        )
    for item in items:
        kind, name = item["kind"], item["metadata"]["name"]
        service = "platform" if name.startswith("platform-") else "newsletter"
        if kind == "Deployment":
            pod = item["spec"]["template"]["spec"]
            require(item["spec"].get("replicas") == 1, "REPAIR_RUNTIME_INVALID")
            for container in (*pod.get("initContainers", []), *pod["containers"]):
                require(container["image"] == images[service], "REPAIR_IMAGES_INVALID")
        elif kind == "CronJob":
            require(
                item["spec"]["suspend"] is (name == "newsletter-daily"),
                "REPAIR_RUNTIME_NOT_HELD",
            )
            containers = item["spec"]["jobTemplate"]["spec"]["template"]["spec"][
                "containers"
            ]
            require(
                all(container["image"] == images[service] for container in containers),
                "REPAIR_IMAGES_INVALID",
            )
        elif kind == "ConfigMap" and name != "platform-runtime-config":
            require(
                item["data"]
                == {
                    "image": images[service],
                    "source_sha": public["source_sha"],
                    "request_id": identity(public["source_sha"]),
                    "phase": "applying",
                },
                "REPAIR_RELEASE_INVALID",
            )
    return value


def inputs(previous_directory, directory):
    require(
        checksum(Path(previous_directory) / "manifest.json") == PREVIOUS_MANIFEST,
        "REPAIR_PREVIOUS_BUNDLE_MISMATCH",
    )
    previous, public = load_bundle(previous_directory), load_bundle(directory)
    require(previous["source_sha"] == PREVIOUS_SHA, "REPAIR_PREVIOUS_BUNDLE_MISMATCH")
    require(
        public["source_sha"] != PREVIOUS_SHA
        and previous["profile"] == public["profile"],
        "REPAIR_PROFILE_CHANGED",
    )
    require(
        host.bootstrap_completed(PREVIOUS_MANIFEST), "REPAIR_BOOTSTRAP_MARKER_MISSING"
    )
    old_runtime, new_runtime = (
        runtime(previous_directory, previous),
        runtime(directory, public),
    )
    require(
        read_json(Path(previous_directory) / "foundation.json")
        == read_json(Path(directory) / "foundation.json"),
        "REPAIR_FOUNDATION_CHANGED",
    )
    for name in (
        "versions.json",
        "units/k3s.service",
        "units/k3s-config.yaml",
        "units/cloudflared-platform.service",
        "units/firewall.v4",
        "units/firewall.v6",
    ):
        require(
            (Path(previous_directory) / name).read_bytes()
            == (Path(directory) / name).read_bytes(),
            "REPAIR_HOST_CONFIGURATION_CHANGED",
        )
    return previous, public, old_runtime, new_runtime


def empty_ledger(profile):
    path = host.real_path(Path(profile["state_root"]) / "platform/releases.sqlite3")
    require(path.is_file(), "REPAIR_LEDGER_MISSING")
    # Normal read-only SQLite includes committed WAL state. Never select body/observed.
    database = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        database.execute("BEGIN")
        for table in ("releases", "create_receipts", "resume_receipts"):
            require(
                database.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0,
                "REPAIR_API_RELEASE_EXISTS",
            )
    finally:
        database.close()


def marker_identity(directory):
    return {
        "schema_version": 1,
        "previous_bundle_sha256": PREVIOUS_MANIFEST,
        "bundle_sha256": checksum(Path(directory) / "manifest.json"),
    }


def decode(raw):
    require(len(raw) <= 4 * 1024 * 1024, "REPAIR_RESPONSE_TOO_LARGE")
    value = json.loads(raw)
    require(isinstance(value, dict), "REPAIR_RESPONSE_INVALID")
    return value
