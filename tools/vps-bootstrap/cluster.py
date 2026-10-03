"""Pinned K3s bootstrap and bounded admin-only setup; routine releases never use this identity."""

import base64
import json
import time
from pathlib import Path

import binaries
from host import directory, write_file
from runner import command

from config import BootstrapError, read_json, require

BINARY = Path("/usr/local/bin/k3s")
KUBECONFIG = "/etc/rancher/k3s/k3s.yaml"


def kubectl(args, *, data=None, timeout=60, check=True):
    return command(
        [str(BINARY), "kubectl", "--kubeconfig", KUBECONFIG, *args],
        data=data,
        timeout=timeout,
        check=check,
    )


def pinned_binary(versions):
    version = versions["k3s"]["version"].replace("+", "%2B")
    url = "https://github.com/k3s-io/k3s/releases/download/" + version + "/k3s"
    binaries.pinned_binary(
        BINARY,
        url,
        versions["k3s"]["linux_amd64_sha256"],
        "FOREIGN_K3S_INSTALLATION",
    )


def start(bundle):
    bundle = Path(bundle)
    pinned_binary(read_json(bundle / "versions.json"))
    directory("/etc/rancher/k3s", mode=0o700)
    write_file(
        "/etc/rancher/k3s/config.yaml", (bundle / "units/k3s-config.yaml").read_bytes()
    )
    for name in ("firewall.v4", "firewall.v6"):
        write_file(
            Path("/etc/rancher/k3s") / name, (bundle / "units" / name).read_bytes()
        )
    write_file(
        "/etc/systemd/system/k3s.service",
        (bundle / "units/k3s.service").read_bytes(),
        mode=0o644,
    )
    command(["systemctl", "daemon-reload"])
    command(["systemctl", "enable", "--now", "k3s.service"], timeout=120)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        result = kubectl(["get", "--raw=/readyz"], check=False, timeout=10)
        if result.returncode == 0:
            require(
                Path(KUBECONFIG).stat().st_mode & 0o077 == 0, "KUBECONFIG_NOT_PRIVATE"
            )
            return
        time.sleep(2)
    raise BootstrapError("K3S_READY_TIMEOUT")


def apply(value):
    kubectl(
        ["apply", "--server-side", "--field-manager=personal-cloud", "-f", "-"],
        data=json.dumps(value).encode(),
        timeout=120,
    )


def secrets(profile, private):
    namespace = profile["namespace"]
    items = []
    for name, variables in (
        ("newsletter-settings", private["newsletter_env"]),
        ("newsletter-trigger", private["trigger_env"]),
        ("platform-settings", private["platform_env"]),
        (
            "fleet-observer-settings",
            {
                "FLEET_REPORT_HMAC_KEY": private["fleet_key"],
                "FLEET_REPORT_URL": "https://"
                + profile["fleet_host"]
                + "/api/internal/fleet/v1/receipt",
            },
        ),
    ):
        items.append(
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {"name": name, "namespace": namespace},
                "type": "Opaque",
                "data": {
                    key: base64.b64encode(value.encode()).decode()
                    for key, value in variables.items()
                },
            }
        )
    apply({"apiVersion": "v1", "kind": "List", "items": items})


def held_runtime(bundle, namespace):
    apply(read_json(Path(bundle) / "runtime.json"))
    for name in ("newsletter", "newsletter-config-sync", "platform-runtime"):
        kubectl(
            [
                "-n",
                namespace,
                "rollout",
                "status",
                "deployment/" + name,
                "--timeout=300s",
            ],
            timeout=330,
        )


def services(bundle, private, cloudflared):
    bundle = Path(bundle)
    connector_directory = Path("/etc/cloudflared")
    if not connector_directory.exists():
        directory(connector_directory, mode=0o700)
    require(
        connector_directory.is_dir() and not connector_directory.is_symlink(),
        "CONNECTOR_DIRECTORY_INVALID",
    )
    write_file("/etc/cloudflared/platform-token", private["connector_token"].encode())
    for name in ("cloudflared-platform.service",):
        text = (
            (bundle / "units" / name).read_text().replace("@CLOUDFLARED@", cloudflared)
        )
        write_file(Path("/etc/systemd/system") / name, text.encode(), mode=0o644)
    command(["systemctl", "daemon-reload"])
    command(
        ["systemctl", "enable", "--now", "cloudflared-platform.service"],
        timeout=45,
    )
