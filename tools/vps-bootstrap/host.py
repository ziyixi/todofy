"""One-time retained filesystem migration; no source deletion or content parsing."""

import json
import os
import shutil
import tempfile
from pathlib import Path

from runner import command

from config import BootstrapError, read_json, require

COMPLETION_MARKER = Path("/etc/rancher/k3s/personal-cloud-bootstrap.json")


def bootstrap_completed(bundle_sha256):
    marker = real_path(COMPLETION_MARKER)
    if not marker.exists():
        return False
    require(
        marker.is_file()
        and marker.stat().st_uid == 0
        and marker.stat().st_mode & 0o777 == 0o600,
        "BOOTSTRAP_COMPLETION_MARKER_INVALID",
    )
    require(
        read_json(marker, private=True)
        == {"schema_version": 1, "bundle_sha256": bundle_sha256},
        "BOOTSTRAP_ALREADY_INITIALIZED_DIFFERENT_BUNDLE",
    )
    return True


def complete_bootstrap(bundle_sha256):
    write_file(
        COMPLETION_MARKER,
        json.dumps(
            {"schema_version": 1, "bundle_sha256": bundle_sha256}, sort_keys=True
        ).encode(),
    )


def real_path(path):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "HOST_PATH_INVALID")
    require(
        not any(parent.is_symlink() for parent in (path, *path.parents)),
        "HOST_SYMLINK_REFUSED",
    )
    return path


def write_file(path, content, *, mode=0o600, uid=0, gid=0, replace=False):
    path = real_path(path)
    require(path.parent.is_dir(), "HOST_DIRECTORY_MISSING")
    if path.exists():
        require(path.is_file(), "HOST_FILE_INVALID")
        if not replace:
            require(path.read_bytes() == content, "MANAGED_FILE_CONFLICT")
    name = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=".personal-cloud-", delete=False
        ) as temporary:
            name = temporary.name
            os.fchmod(temporary.fileno(), mode)
            os.fchown(temporary.fileno(), uid, gid)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if name is not None:
            Path(name).unlink(missing_ok=True)


def directory(path, *, uid=0, gid=0, mode=0o700):
    path = real_path(path)
    path.mkdir(parents=True, exist_ok=True)
    require(path.is_dir(), "HOST_DIRECTORY_INVALID")
    os.chown(path, uid, gid)
    os.chmod(path, mode)
    return path


def stopped_sources(sources):
    if not sources or shutil.which("docker") is None:
        return
    result = command(["docker", "ps", "-q"], check=False)
    if result.returncode:
        active = command(["systemctl", "is-active", "docker.service"], check=False)
        require(active.returncode != 0, "LEGACY_STATUS_UNAVAILABLE")
        return
    identifiers = result.stdout.decode().split()
    require(len(identifiers) <= 128, "LEGACY_STATUS_UNAVAILABLE")
    for identifier in identifiers:
        require(
            all(c in "0123456789abcdef" for c in identifier),
            "LEGACY_STATUS_UNAVAILABLE",
        )
        value = command(
            ["docker", "inspect", "--format", "{{json .Mounts}}", identifier]
        )
        try:
            mounts = json.loads(value.stdout)
        except ValueError:
            raise BootstrapError("LEGACY_STATUS_UNAVAILABLE") from None
        require(isinstance(mounts, list), "LEGACY_STATUS_UNAVAILABLE")
        for mount in mounts:
            path = Path(mount.get("Source", "/nonexistent"))
            for source in sources:
                require(
                    not (
                        path == source
                        or path in source.parents
                        or source in path.parents
                    ),
                    "LEGACY_CONTAINER_STILL_RUNNING",
                )


def migrate(state_root, old_paths, sha):
    root = real_path(state_root)
    sources = {name: real_path(path) for name, path in old_paths.items()}
    for source in sources.values():
        require(source.is_dir(), "LEGACY_DIRECTORY_MISSING")
        for path in source.rglob("*"):
            require(
                not path.is_symlink() and (path.is_file() or path.is_dir()),
                "LEGACY_UNSAFE_FILE",
            )
    stopped_sources(sources.values())
    directory(root, mode=0o755)
    marker = root / ".bootstrap-state.json"
    if marker.exists():
        previous = read_json(marker, private=True)
        require(
            previous == {"schema_version": 1, "source_sha": sha},
            "BOOTSTRAP_IDENTITY_CONFLICT",
        )
        return
    directory(root / "newsletter", mode=0o755)
    for name in ("data", "auth", "config"):
        target = real_path(root / "newsletter" / name)
        require(
            not target.exists() or (target.is_dir() and not any(target.iterdir())),
            "DESTINATION_STATE_CONFLICT",
        )
        source = sources.get(name)
        if source:
            staging = target.with_name("." + name + ".bootstrap-" + sha[:12])
            require(not staging.exists(), "PARTIAL_MIGRATION_REQUIRES_REVIEW")
            shutil.copytree(source, staging, symlinks=False)
            if target.exists():
                target.rmdir()
            os.replace(staging, target)
        else:
            target.mkdir(exist_ok=True)
        os.chown(target, 10001, 10001)
        os.chmod(target, 0o700)
        for path in target.rglob("*"):
            os.chown(path, 10001, 10001)
    directory(root / "platform", uid=10001, gid=10001, mode=0o700)
    directory(root / "observer", uid=10001, gid=10001, mode=0o700)
    write_file(
        marker,
        json.dumps({"schema_version": 1, "source_sha": sha}, sort_keys=True).encode(),
    )


def retire_legacy_runtime():
    """Retire authorized Compose runtime units after preserving state; keep files/images."""
    units = []
    for unit in ("docker.socket", "docker.service"):
        result = command(
            [
                "systemctl",
                "show",
                unit,
                "--property=LoadState",
                "--value",
                "--no-pager",
            ],
            check=False,
        )
        state = result.stdout.decode().strip()
        require(state in {"loaded", "masked", "not-found"}, "LEGACY_STATUS_UNAVAILABLE")
        if state == "loaded":
            units.append(unit)
        elif state == "masked":
            active = command(["systemctl", "is-active", unit], check=False)
            require(active.returncode != 0, "LEGACY_RUNTIME_CONFLICT")
    if units:
        command(["systemctl", "disable", "--now", *units], timeout=120)
