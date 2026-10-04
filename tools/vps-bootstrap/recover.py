"""Owner-run recovery of the registered host transport and current accepted deployment daemon."""

import argparse
import copy
import json
import os
import re
import sqlite3
import time
from pathlib import Path

import binaries
import cluster
import host
import observer_policy
from runner import command

from config import BootstrapError, checksum, load_bundle, read_json, require

PROFILE_FIELDS = {
    "namespace",
    "state_root",
    "observer_node_key",
    "fleet_host",
    "runtime_host",
    "repository",
}
RUNTIME_NAMES = {"platform-runtime", "platform-runtime-config", "platform-release"}
UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)


def accepted_release(profile, public):
    """Read immutable release metadata only; never open Newsletter state."""
    ledger = host.real_path(Path(profile["state_root"]) / "platform/releases.sqlite3")
    require(ledger.is_file(), "RECOVERY_LEDGER_MISSING")
    with sqlite3.connect(ledger.as_uri() + "?mode=ro", uri=True, timeout=5) as database:
        database.row_factory = sqlite3.Row
        row = database.execute(
            "SELECT identity,body,phase,checkpoint FROM releases ORDER BY created DESC,rowid DESC LIMIT 1"
        ).fetchone()
    require(
        row is not None and UUID.fullmatch(row["identity"]), "RECOVERY_RELEASE_MISSING"
    )
    require(
        isinstance(row["body"], str) and len(row["body"]) <= 16384,
        "RECOVERY_LEDGER_INVALID",
    )
    body = json.loads(row["body"])
    require(
        isinstance(body, dict)
        and set(body) == {"request_id", "targets"}
        and isinstance(body["request_id"], str)
        and UUID.fullmatch(body["request_id"]),
        "RECOVERY_LEDGER_INVALID",
    )
    targets = body["targets"]
    require(
        isinstance(targets, list)
        and len(targets) == 2
        and {item.get("workload_key") for item in targets if isinstance(item, dict)}
        == {"newsletter", "platform-runtime"},
        "RECOVERY_LEDGER_INVALID",
    )
    for item in targets:
        require(
            set(item) == {"workload_key", "source_sha", "image_digest", "request_id"}
            and item["source_sha"] == public["source_sha"]
            and item["request_id"] == body["request_id"],
            "RECOVERY_BUNDLE_NOT_CURRENT_ACCEPTED",
        )
        image = public["images"][
            "platform" if item["workload_key"] == "platform-runtime" else "newsletter"
        ]
        require(
            item["image_digest"] == image.split("@", 1)[1],
            "RECOVERY_BUNDLE_NOT_CURRENT_ACCEPTED",
        )
    require(
        row["phase"]
        in {
            "accepted",
            "draining",
            "frozen",
            "applying",
            "verifying",
            "ready",
            "held",
            "failed",
        },
        "RECOVERY_LEDGER_INVALID",
    )
    return {
        "identity": row["identity"],
        "request_id": body["request_id"],
        "phase": row["phase"],
        "activation": "activated"
        if row["checkpoint"] in {"resume", "unsuspend", "finish", "done"}
        else "applying",
    }


def runtime_resources(bundle, public, release):
    selected = []
    for source in read_json(Path(bundle) / "runtime.json")["items"]:
        name = source["metadata"]["name"]
        if name not in RUNTIME_NAMES:
            continue
        item = copy.deepcopy(source)
        require(
            item["metadata"]["namespace"] == public["profile"]["namespace"],
            "RECOVERY_RUNTIME_INVALID",
        )
        if item["kind"] == "Deployment":
            container = item["spec"]["template"]["spec"]["containers"][0]
            require(
                container["image"] == public["images"]["platform"],
                "RECOVERY_RUNTIME_INVALID",
            )
            for variable in container["env"]:
                if variable["name"] == "PLATFORM_RELEASE_REQUEST_ID":
                    variable["value"] = release["request_id"]
            item["spec"]["template"].setdefault("metadata", {}).setdefault(
                "annotations", {}
            )["personal-cloud/request-id"] = release["request_id"]
        elif item["kind"] == "ConfigMap" and name == "platform-release":
            item["data"]["request_id"] = release["request_id"]
            item["data"].pop("phase", None)
        selected.append(item)
    require(
        {(item["kind"], item["metadata"]["name"]) for item in selected}
        == {
            ("Deployment", "platform-runtime"),
            ("Service", "platform-runtime"),
            ("ConfigMap", "platform-runtime-config"),
            ("ConfigMap", "platform-release"),
        },
        "RECOVERY_RUNTIME_INVALID",
    )
    return selected


def host_services(installed, bundle):
    require(
        read_json(Path(installed) / "versions.json")
        == read_json(Path(bundle) / "versions.json"),
        "RECOVERY_HOST_VERSION_REVIEW_REQUIRED",
    )
    for name in (
        "k3s-config.yaml",
        "firewall.v4",
        "firewall.v6",
        "k3s.service",
        "cloudflared-platform.service",
        "personal-cloud-systemd-observer-v1",
    ):
        require(
            (Path(installed) / "units" / name).read_bytes()
            == (Path(bundle) / "units" / name).read_bytes(),
            "RECOVERY_HOST_CONFIGURATION_REVIEW_REQUIRED",
        )
    versions = read_json(Path(bundle) / "versions.json")
    require(
        checksum(cluster.BINARY) == versions["k3s"]["linux_amd64_sha256"],
        "RECOVERY_HOST_BINARY_REVIEW_REQUIRED",
    )
    connector = binaries.connector_preflight(versions)
    token = host.real_path(Path("/etc/cloudflared/platform-token"))
    require(
        token.is_file()
        and token.stat().st_uid == 0
        and token.stat().st_mode & 0o077 == 0,
        "RECOVERY_TRANSPORT_CREDENTIAL_MISSING",
    )
    for name in ("k3s.service", "cloudflared-platform.service"):
        content = (
            (Path(bundle) / "units" / name)
            .read_text()
            .replace("@CLOUDFLARED@", connector)
            .encode()
        )
        host.write_file(
            Path("/etc/systemd/system") / name, content, mode=0o644, replace=True
        )
    for name in ("k3s-config.yaml", "firewall.v4", "firewall.v6"):
        destination = "config.yaml" if name == "k3s-config.yaml" else name
        host.write_file(
            Path("/etc/rancher/k3s") / destination,
            (Path(bundle) / "units" / name).read_bytes(),
            replace=True,
        )
    observer_policy.install(bundle)
    command(["systemctl", "daemon-reload"])
    command(["systemctl", "enable", "k3s.service"], timeout=30)
    command(["systemctl", "restart", "k3s.service"], timeout=120)
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if (
            cluster.kubectl(
                ["get", "--raw=/readyz"], check=False, timeout=10
            ).returncode
            == 0
        ):
            break
        time.sleep(2)
    else:
        raise BootstrapError("RECOVERY_CLUSTER_UNAVAILABLE")
    command(["systemctl", "enable", "cloudflared-platform.service"], timeout=30)
    command(["systemctl", "restart", "cloudflared-platform.service"], timeout=45)


def recover(installed, bundle):
    require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_OWNER_RECOVERY")
    original, public = load_bundle(installed), load_bundle(bundle)
    require(
        host.bootstrap_completed(checksum(Path(installed) / "manifest.json")),
        "RECOVERY_BOOTSTRAP_MARKER_MISSING",
    )
    require(
        {key: original["profile"][key] for key in PROFILE_FIELDS}
        == {key: public["profile"][key] for key in PROFILE_FIELDS},
        "RECOVERY_PROFILE_CHANGED",
    )
    require(
        Path(__file__).resolve() == (Path(bundle) / "installer/recover.py").resolve(),
        "RECOVERY_SCRIPT_NOT_IN_BUNDLE",
    )
    expected = accepted_release(public["profile"], public)
    host_services(installed, bundle)
    namespace = public["profile"]["namespace"]
    for kind, names in (
        (
            "persistentvolumeclaim",
            (
                "platform-state",
                "newsletter-data",
                "newsletter-auth",
                "newsletter-config",
                "observer-state",
            ),
        ),
        (
            "secret",
            (
                "platform-settings",
                "newsletter-settings",
                "newsletter-trigger",
                "fleet-observer-settings",
            ),
        ),
    ):
        for name in names:
            cluster.kubectl(["-n", namespace, "get", kind, name, "-o", "name"])
    deployment = cluster.kubectl(
        [
            "-n",
            namespace,
            "get",
            "deployment/platform-runtime",
            "--ignore-not-found",
            "-o",
            "name",
        ]
    )
    if deployment.stdout.strip():
        # Use the existing runtime field manager so restoring replicas does not add
        # a foreign Scale manager that would block the controller's normal SSA.
        cluster.kubectl(
            [
                "-n",
                namespace,
                "patch",
                "deployment/platform-runtime",
                "--type=merge",
                "--field-manager=personal-cloud",
                "-p",
                '{"spec":{"replicas":0}}',
            ]
        )
    cluster.kubectl(
        [
            "-n",
            namespace,
            "wait",
            "--for=delete",
            "pod",
            "-l",
            "app=platform-runtime",
            "--timeout=120s",
        ],
        timeout=130,
    )
    release = accepted_release(public["profile"], public)
    require(
        release["identity"] == expected["identity"], "RECOVERY_ACCEPTED_RELEASE_CHANGED"
    )
    for item in runtime_resources(bundle, public, release):
        cluster.apply(item)
    cluster.kubectl(
        [
            "-n",
            namespace,
            "apply",
            "--server-side",
            "--field-manager=personal-cloud-runtime-status",
            "--force-conflicts",
            "-f",
            "-",
        ],
        data=json.dumps(
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": "platform-release", "namespace": namespace},
                "data": {"phase": release["activation"]},
            }
        ).encode(),
    )
    cluster.kubectl(
        [
            "-n",
            namespace,
            "rollout",
            "status",
            "deployment/platform-runtime",
            "--timeout=300s",
        ],
        timeout=330,
    )
    return {
        "event": "vps_owner_recovery",
        "status": "runtime_restored",
        "release": "releases/" + release["identity"],
        "phase": release["phase"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-bundle", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(recover(args.installed_bundle, args.bundle)))
        return 0
    except BootstrapError as error:
        code = str(error)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        code = "RECOVERY_INPUT_OR_STATE_INVALID"
    print(
        json.dumps(
            {"event": "vps_owner_recovery", "status": "failed", "error_code": code}
        )
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
