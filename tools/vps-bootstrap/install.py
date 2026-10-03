"""One-time privileged VPS bootstrap; preserves state and retires the authorized old Compose runtime."""

import argparse
import json
import os
import platform
import shutil
from pathlib import Path

import cluster
import firewall
import host

from config import (
    BootstrapError,
    checksum,
    credentials,
    load_bundle,
    read_json,
    require,
)


def event(phase, status):
    print(
        json.dumps({"event": "vps_bootstrap", "phase": phase, "status": status}),
        flush=True,
    )


def preflight(bundle):
    require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_INITIAL_BOOTSTRAP")
    require(
        platform.system() == "Linux" and platform.machine() == "x86_64",
        "PLATFORM_UNSUPPORTED",
    )
    distribution = platform.freedesktop_os_release()
    require(
        distribution.get("ID") == "ubuntu"
        and distribution.get("VERSION_ID") == "24.04",
        "DISTRIBUTION_UNSUPPORTED",
    )
    for binary in (
        "systemctl",
        "iptables",
        "ip6tables",
        "iptables-restore",
        "ip6tables-restore",
    ):
        require(shutil.which(binary) is not None, "SYSTEM_PREREQUISITE_MISSING")
    cloudflared = shutil.which("cloudflared")
    require(
        cloudflared is not None
        and cloudflared in {"/usr/bin/cloudflared", "/usr/local/bin/cloudflared"},
        "CLOUDFLARED_PREREQUISITE_MISSING",
    )
    for name in (
        "k3s.service",
        "cloudflared-platform.service",
    ):
        destination = host.real_path(Path("/etc/systemd/system") / name)
        desired = (
            (Path(bundle) / "units" / name)
            .read_text()
            .replace("@CLOUDFLARED@", cloudflared)
            .encode()
        )
        if destination.exists():
            require(
                destination.is_file() and destination.read_bytes() == desired,
                "SYSTEM_UNIT_CONFLICT",
            )
    configuration = host.real_path(Path("/etc/rancher/k3s/config.yaml"))
    if configuration.exists():
        require(
            configuration.is_file()
            and configuration.read_bytes()
            == (Path(bundle) / "units/k3s-config.yaml").read_bytes(),
            "K3S_CONFIGURATION_CONFLICT",
        )
    return cloudflared


def install(bundle, private_file):
    public = load_bundle(bundle)
    require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_INITIAL_BOOTSTRAP")
    bundle_sha256 = checksum(Path(bundle) / "manifest.json")
    if host.bootstrap_completed(bundle_sha256):
        event("bootstrap", "already_initialized")
        return
    allowed = read_json(Path(bundle) / "allowedkeys.json")
    private = credentials(private_file, allowed)
    cloudflared = preflight(bundle)
    profile = public["profile"]
    event("inputs", "verified")
    host.migrate(profile["state_root"], private["old_paths"], public["source_sha"])
    event("state", "preserved")
    host.retire_legacy_runtime()
    event("legacy_runtime", "stopped")
    firewall.install()
    cluster.start(bundle)
    event("cluster", "ready")
    cluster.apply(read_json(Path(bundle) / "foundation.json"))
    cluster.secrets(profile, private)
    cluster.held_runtime(bundle, profile["namespace"])
    event("runtime", "held")
    cluster.services(bundle, private, cloudflared)
    host.complete_bootstrap(bundle_sha256)
    event("bootstrap", "complete_held")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--credentials", type=Path, required=True)
    args = parser.parse_args()
    try:
        install(args.bundle, args.credentials)
    except BootstrapError as error:
        print(
            json.dumps(
                {
                    "event": "vps_bootstrap",
                    "phase": "bootstrap",
                    "status": "failed",
                    "code": str(error),
                }
            ),
            flush=True,
        )
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        event("bootstrap", "failed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
