"""Install only the pinned observer AppArmor profile; no credentials or services."""

import argparse
import hashlib
import json
import os
import platform
import stat
from pathlib import Path

import host
from runner import command

from config import BootstrapError, require

PROFILE = "personal-cloud-systemd-observer-v1"
PROFILE_SHA256 = "442721016b9ea0cb43076c58205db8f1aa15879f9737905c72d4e01f98fa06c7"
DESTINATION = Path("/etc/apparmor.d") / PROFILE
PARSER = Path("/usr/sbin/apparmor_parser")
ENABLED = Path("/sys/module/apparmor/parameters/enabled")
PROFILES = Path("/sys/kernel/security/apparmor/profiles")


def secure_path(path, *, directory=False, mode=None):
    selected = host.real_path(path)
    attributes = selected.stat()
    require(
        (selected.is_dir() if directory else selected.is_file())
        and attributes.st_uid == 0
        and attributes.st_gid == 0
        and not stat.S_IMODE(attributes.st_mode) & 0o022
        and (mode is None or stat.S_IMODE(attributes.st_mode) == mode),
        "OBSERVER_POLICY_PATH_INVALID",
    )
    return selected


def loaded():
    require(PROFILES.is_file(), "APPARMOR_STATUS_UNAVAILABLE")
    with PROFILES.open() as source:
        for number, line in enumerate(source):
            require(number < 4096, "APPARMOR_STATUS_UNAVAILABLE")
            if line.startswith(PROFILE + " "):
                return line.strip()
    return None


def preflight(bundle):
    require(os.geteuid() == 0, "ROOT_REQUIRED_FOR_OBSERVER_POLICY")
    require(platform.system() == "Linux", "PLATFORM_UNSUPPORTED")
    distribution = platform.freedesktop_os_release()
    require(
        distribution.get("ID") == "ubuntu"
        and distribution.get("VERSION_ID") == "24.04",
        "DISTRIBUTION_UNSUPPORTED",
    )
    source = host.real_path(Path(bundle).absolute() / "units" / PROFILE)
    require(
        source.is_file() and source.stat().st_size <= 16384, "OBSERVER_POLICY_INVALID"
    )
    with source.open("rb") as handle:
        content = handle.read(16385)
    require(
        len(content) <= 16384 and hashlib.sha256(content).hexdigest() == PROFILE_SHA256,
        "OBSERVER_POLICY_HASH_MISMATCH",
    )
    require(ENABLED.read_text().strip() == "Y", "APPARMOR_NOT_ENABLED")
    secure_path(PARSER, mode=0o755)
    for parent in (*PARSER.parents, DESTINATION.parent, *DESTINATION.parent.parents):
        secure_path(parent, directory=True)
    destination = host.real_path(DESTINATION)
    if destination.exists():
        secure_path(destination, mode=0o644)
        require(
            destination.stat().st_size == len(content)
            and destination.read_bytes() == content,
            "FOREIGN_OBSERVER_POLICY",
        )
    else:
        require(loaded() is None, "FOREIGN_OBSERVER_POLICY")
    command(["systemctl", "is-active", "--quiet", "apparmor.service"])
    command(["systemctl", "is-enabled", "--quiet", "apparmor.service"])
    command(
        [str(PARSER), "--skip-kernel-load", "--skip-cache", "--quiet"],
        data=content,
    )
    return content


def install(bundle):
    content = preflight(bundle)
    if not DESTINATION.exists():
        host.write_file(DESTINATION, content, mode=0o644)
    command([str(PARSER), "--replace", "--skip-cache", "--quiet", str(DESTINATION)])
    require(loaded() == PROFILE + " (enforce)", "OBSERVER_POLICY_NOT_ENFORCING")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    try:
        install(args.bundle)
    except BootstrapError as error:
        print(
            json.dumps(
                {"event": "observer_policy", "status": "failed", "code": str(error)}
            )
        )
        return 1
    except (OSError, ValueError, UnicodeError):
        print(
            json.dumps(
                {
                    "event": "observer_policy",
                    "status": "failed",
                    "code": "SYSTEM_PREREQUISITE_UNAVAILABLE",
                }
            )
        )
        return 1
    print(json.dumps({"event": "observer_policy", "status": "enforcing"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
