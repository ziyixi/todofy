"""Build and stage a Worker release archive without credentials or a second compilation."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tomllib
from pathlib import Path

from control import WORKERS

ROOT = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build(app: str, sha: str, directory: Path, target: str) -> None:
    """Save the canonical Bazel target and its source identity for the release job."""
    if app not in WORKERS or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("A Worker application and full source SHA are required")
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    if head != sha:
        raise ValueError("The release SHA must match the checked-out source")
    cache = Path.home() / ".cache/personal-cloud-bazel"
    options = [
        "--stamp",
        "--embed_label=" + sha,
        "--repository_cache=" + str(cache / "repository"),
        "--disk_cache=" + str(cache / "actions"),
    ]
    subprocess.run(["bazel", "build", target, *options], cwd=ROOT, check=True)
    outputs = subprocess.check_output(
        ["bazel", "cquery", target, *options, "--output=files"], cwd=ROOT, text=True
    ).splitlines()
    if len(outputs) != 1:
        raise ValueError("The application must produce one release archive")
    directory.mkdir(parents=True, exist_ok=False)
    archive = directory / "worker.tar.gz"
    shutil.copyfile(ROOT / outputs[0], archive)
    (directory / "manifest.json").write_text(
        json.dumps(
            {"app": app, "sha": sha, "archive_sha256": digest(archive)}, sort_keys=True
        )
        + "\n"
    )


def stage(app: str, sha: str, directory: Path, source: Path) -> None:
    """Verify the checked archive and expose compiled files beside the original configuration."""
    manifest = json.loads((directory / "manifest.json").read_text())
    archive = directory / "worker.tar.gz"
    if app not in WORKERS or manifest != {
        "app": app,
        "sha": sha,
        "archive_sha256": digest(archive),
    }:
        raise ValueError("Worker artifact identity or checksum mismatch")
    root = source / ("website" if app == "website-relay" else app)
    destination = root / ".compiled"
    destination.mkdir(exist_ok=False)
    with tarfile.open(archive) as bundle:
        bundle.extractall(destination, filter="data")
    for config in WORKERS[app]:
        original = source / config
        relative = original.relative_to(root)
        packaged = destination / ("config" if app == "todofy" else "") / relative
        if original.read_bytes() != packaged.read_bytes():
            raise ValueError(
                "The archive configuration differs from the selected source"
            )
    if app == "todofy":
        # base_dir stays `worker` in the authoritative Python config. These are only ephemeral checkout files.
        shutil.rmtree(root / "worker")
        shutil.copytree(
            destination / "core",
            root / "worker",
            ignore=shutil.ignore_patterns("python_modules"),
        )
        shutil.copytree(
            destination / "core/python_modules",
            root / "python_modules",
            dirs_exist_ok=True,
        )
        gateway = tomllib.loads((root / "gateway/wrangler.toml").read_text())
        assets = root / "gateway" / gateway["assets"]["directory"]
        shutil.copytree(destination / "assets", assets, dirs_exist_ok=True)
    else:
        config = tomllib.loads((source / WORKERS[app][0]).read_text())
        if assets := config.get("assets"):
            relative = Path(assets["directory"])
            shutil.copytree(destination / relative, root / relative, dirs_exist_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "stage"))
    parser.add_argument("--app", choices=sorted(WORKERS), required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument(
        "--target",
        help="The archive target declared by the application's release facade",
    )
    parser.add_argument("--source-root", type=Path, default=Path(".release-source"))
    args = parser.parse_args()
    if args.command == "build":
        if not args.target:
            parser.error(
                "--target is required when building the declared release archive"
            )
        build(args.app, args.sha, args.directory, args.target)
    else:
        stage(args.app, args.sha, args.directory, args.source_root)
