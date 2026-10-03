"""Pinned K3s bootstrap and bounded admin-only setup; routine releases never use this identity."""

import base64
import json
import tempfile
import time
import urllib.request
from pathlib import Path

from host import directory, write_file
from runner import command

from config import BootstrapError, checksum, read_json, require

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
    expected = versions["k3s"]["linux_amd64_sha256"]
    if BINARY.exists():
        require(
            BINARY.is_file()
            and not BINARY.is_symlink()
            and checksum(BINARY) == expected,
            "FOREIGN_K3S_INSTALLATION",
        )
        return
    require(
        BINARY.parent.is_dir() and not BINARY.parent.is_symlink(),
        "BINARY_DIRECTORY_INVALID",
    )
    version = versions["k3s"]["version"].replace("+", "%2B")
    url = "https://github.com/k3s-io/k3s/releases/download/" + version + "/k3s"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 600
    with tempfile.NamedTemporaryFile(
        dir=BINARY.parent, prefix=".personal-cloud-k3s-", delete=False
    ) as target:
        temporary = Path(target.name)
        try:
            with opener.open(url, timeout=30) as response:
                require(
                    response.geturl().startswith("https://"), "BINARY_SOURCE_INVALID"
                )
                length = 0
                while chunk := response.read(65536):
                    length += len(chunk)
                    require(
                        length <= 200 * 1024 * 1024 and time.monotonic() < deadline,
                        "BINARY_DOWNLOAD_TOO_LARGE",
                    )
                    target.write(chunk)
            target.flush()
            require(checksum(temporary) == expected, "BINARY_CHECKSUM_MISMATCH")
            write_file(BINARY, temporary.read_bytes(), mode=0o755)
        finally:
            temporary.unlink(missing_ok=True)


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
    command(["systemctl", "enable", "--now", "cloudflared-platform.service"])
