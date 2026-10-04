#!/usr/bin/env python3
"""Publish exactly the independent service image tested by the CI gate."""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

import tomllib

IMAGE = "ghcr.io/ziyixi/todofy-newsletter"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inspect(image: str) -> str:
    value = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("Invalid tested image ID")
    return value


def registry_digest(image: str, repository: str = IMAGE) -> str:
    values = json.loads(subprocess.check_output(
        ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image], text=True))
    matches = {value for value in values or [] if isinstance(value, str)
               and re.fullmatch(re.escape(repository) + r"@sha256:[0-9a-f]{64}", value)}
    if len(matches) != 1:
        raise ValueError("Published registry digest is unavailable or ambiguous")
    return matches.pop()


def save(image: str, sha: str, directory: Path) -> None:
    image_id = inspect(image)
    directory.mkdir(parents=True, exist_ok=False)
    archive = directory / "image.tar"
    subprocess.run(["docker", "save", "--output", str(archive), image_id], check=True)
    (directory / "manifest.json").write_text(json.dumps({"version": 1, "sha": sha, "image_id": image_id,
                                                       "archive_sha256": digest(archive)}, sort_keys=True) + "\n")


def verify(sha: str, directory: Path) -> dict:
    manifest_path, archive = directory / "manifest.json", directory / "image.tar"
    if directory.is_symlink() or any(p.is_symlink() or not p.is_file() for p in (manifest_path, archive)):
        raise ValueError("Release artifact is missing or unsafe")
    if manifest_path.stat().st_size > 2048:
        raise ValueError("Invalid release manifest")
    manifest = json.loads(manifest_path.read_text())
    if (not isinstance(manifest, dict) or set(manifest) != {"version", "sha", "image_id", "archive_sha256"}
            or type(manifest["version"]) is not int or manifest["version"] != 1 or manifest["sha"] != sha
            or not isinstance(manifest["image_id"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["image_id"])
            or manifest["archive_sha256"] != digest(archive)):
        raise ValueError("Release artifact identity or checksum mismatch")
    return manifest


def publish(sha: str, directory: Path, repository: str = IMAGE) -> dict:
    manifest = verify(sha, directory)
    # There is no build in this job. Both the checked tar bytes and the loaded image ID must match.
    subprocess.run(["docker", "load", "--input", str(directory / "image.tar")], check=True)
    image_id = manifest["image_id"]
    if inspect(image_id) != image_id:
        raise ValueError("Loaded image differs from the tested image")
    for tag in (f"service-{sha}", "service"):
        target = f"{repository}:{tag}"
        subprocess.run(["docker", "tag", image_id, target], check=True)
        subprocess.run(["docker", "push", target], check=True)
    # Docker image IDs are not registry manifest digests. Promotion must pin this pullable identity.
    receipt = {"source_sha": sha, "tested_image_id": image_id,
               "image": registry_digest(f"{repository}:service-{sha}", repository)}
    print(json.dumps(receipt, sort_keys=True))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("save", "publish"))
    parser.add_argument("--sha", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--image")
    parser.add_argument("--service", choices=("newsletter", "platform"), default="newsletter")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--github-output", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("Expected a full source commit SHA")
    if args.command == "save":
        if not args.image:
            parser.error("save requires --image")
        save(args.image, args.sha, args.directory)
    else:
        profile = tomllib.loads((Path(__file__).resolve().parents[2] / "config/cloud.toml").read_text())
        repository = profile["repository"].lower()
        receipt = publish(args.sha, args.directory, f"ghcr.io/{repository}-{args.service}")
        if args.receipt:
            args.receipt.write_text(json.dumps(receipt, sort_keys=True) + "\n")
        if args.github_output:
            output = os.environ.get("GITHUB_OUTPUT")
            if not output:
                raise ValueError("Missing Actions output file")
            with open(output, "a") as handle:
                handle.write("image=" + receipt["image"] + "\n")


if __name__ == "__main__":
    main()
