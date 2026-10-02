"""Verify a fixed image in a disposable, credential-free offline container.

Never builds, pulls, pushes, mounts host files, reads .env/auth, or sends mail.
The container runs the existing real SDK startup probe and mock loopback HTTP.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import pathlib
import re
import subprocess
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
PRIVATE_NAMES = (
    ".env*",
    ".codex-auth",
    "codex-auth",
    "auth.json*",
    "credentials*.json",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_ed25519",
    "*.sqlite*",
    "*.db",
    "*.db-shm",
    "*.db-wal",
    "*.eml",
)
IMAGE_FORMAT = (
    '{"id":{{json .Id}},"os":{{json .Os}},'
    '"architecture":{{json .Architecture}},"user":{{json .Config.User}}}'
)


def source_hashes(root: pathlib.Path) -> dict[str, str]:
    """Audit package inputs and hash each regular file expected in the image."""
    package = root / "src" / "newsletter"
    result = {}
    for path in sorted(package.rglob("*")):
        if any(
            fnmatch.fnmatchcase(path.name.lower(), pattern)
            for pattern in PRIVATE_NAMES
        ):
            raise ValueError(
                "Unexpected private-file name inside the source package"
            )
        if path.is_symlink():
            raise ValueError(
                "Image smoke requires regular source files, not symlinks"
            )
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        if path.is_file():
            if path.suffix not in {
                ".py",
                ".pyi",
                ".json",
                ".j2",
                ".md",
                ".yaml",
            }:
                raise ValueError(
                    "Unexpected package file; audit its build inclusion first"
                )
            result[path.relative_to(package).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    if not result:
        raise ValueError("No package source files found")
    return result


def verify(
    image: str,
    platform: str,
    docker: str = "docker",
    *,
    root: pathlib.Path = ROOT,
) -> str:
    """Run offline probes against an immutable image and clean up that probe."""
    inspected = subprocess.run(
        [docker, "image", "inspect", "--format", IMAGE_FORMAT, "--", image],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    metadata: object = json.loads(inspected.stdout)
    if not isinstance(metadata, dict):
        raise ValueError("Docker did not return an image metadata object")
    image_id = metadata["id"]
    if not isinstance(image_id, str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", image_id
    ):
        raise ValueError("Docker did not return a fixed image ID")
    if f"{metadata['os']}/{metadata['architecture']}" != platform:
        raise ValueError(
            "Image architecture does not match the requested platform"
        )
    if metadata["user"].split(":", 1)[0] in {"", "0", "root"}:
        raise ValueError("The image must configure a nonroot user")
    payload = {
        "source_hashes": source_hashes(root),
        "startup_source": (
            root / "scripts" / "smoke_codex_startup.py"
        ).read_text(),
    }
    probe = (root / "scripts" / "smoke_image_probe.py").read_text()
    name = "newsletter-image-smoke-" + uuid.uuid4().hex
    command = [
        docker,
        "run",
        "--rm",
        "--init",
        "--pull",
        "never",
        "--name",
        name,
        "--platform",
        platform,
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
        "--tmpfs",
        "/var/lib/newsletter:rw,nosuid,nodev,noexec,size=64m,uid=10001,gid="
        "10001,mode=0700",
        "--entrypoint",
        "/opt/newsletter/.venv/bin/python",
        "-i",
        image_id,
        "-I",
        "-c",
        probe,
    ]
    try:
        subprocess.run(
            command,
            input=json.dumps(payload),
            text=True,
            check=True,
            timeout=120,
        )
    finally:
        # Killing a timed-out Docker client does not itself stop its container.
        # Target only this unique, self-created probe; tolerate --rm already
        # removing it.
        subprocess.run(
            [docker, "rm", "--force", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=15,
        )
    print(
        f"Image smoke passed for {image_id} ({platform}); "
        "no provider calls or mail."
    )
    return image_id


def main() -> None:
    """Choose a source audit or a no-network, immutable-image smoke test."""
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--image")
    action.add_argument(
        "--audit-source",
        action="store_true",
        help="Check build inputs without Docker",
    )
    parser.add_argument(
        "--platform",
        choices=("linux/amd64", "linux/arm64"),
        default="linux/amd64",
    )
    parser.add_argument("--docker", default="docker")
    args = parser.parse_args()
    if args.audit_source:
        print(
            "Source input audit passed: "
            f"{len(source_hashes(ROOT))} package files."
        )
        return
    verify(args.image, args.platform, args.docker)


if __name__ == "__main__":
    main()
