"""Load a declared OCI archive and run its original credential-free image probe."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--service", choices=("newsletter", "platform", "codex-gateway"), required=True
)
parser.add_argument("--image", type=Path, required=True)
parser.add_argument("--manifest", type=Path, required=True)
args = parser.parse_args()
with tarfile.open(args.image) as image:
    descriptor = json.load(image.extractfile("manifest.json"))[0]
    config_bytes = image.extractfile(descriptor["Config"]).read()
config = json.loads(config_bytes)
sha = config["config"]["Labels"]["org.opencontainers.image.revision"]
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    raise ValueError("The declared image must contain a full source identity")
root = Path(os.environ["TEST_TMPDIR"]).resolve() / "source"
workspace = Path(os.environ["TEST_SRCDIR"]) / os.environ["TEST_WORKSPACE"]
for relative in json.loads(args.manifest.read_text()):
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Image probes require declared workspace sources")
    destination = root / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(workspace / path, destination)
subprocess.run(
    ["docker", "load", "--input", str(args.image)], check=True, capture_output=True
)
metadata = json.loads(
    subprocess.check_output(
        [
            "docker",
            "image",
            "inspect",
            "--format",
            "{{json .}}",
            descriptor["RepoTags"][0],
        ]
    )
)
if metadata["RootFS"]["Layers"] != config["rootfs"]["diff_ids"] or any(
    metadata["Config"].get(name) != value for name, value in config["config"].items()
):
    raise ValueError(
        "The loaded image differs from the declared filesystem or configuration"
    )
image_id = metadata["Id"]
if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
    raise ValueError("Docker must return a fixed image identity")


def run(command, *, source=None):
    subprocess.run(command, input=source, check=True, timeout=120)


if args.service == "newsletter":
    run(
        [
            sys.executable,
            str(root / "newsletter/scripts/smoke_image.py"),
            "--image",
            image_id,
            "--platform",
            "linux/amd64",
        ]
    )
    run(
        [
            sys.executable,
            str(root / "newsletter/scripts/publish_content_config.py"),
            "validate",
            "--image",
            image_id,
            "--engine-sha",
            sha,
            "--revision",
            sha,
            "--source",
            str(root / "newsletter/content-config"),
            "--output",
            str(Path(os.environ["TEST_TMPDIR"]) / "validated-content-config"),
        ]
    )

elif args.service == "codex-gateway":
    run(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "--platform",
            "linux/amd64",
            "--pull",
            "never",
            "--network",
            "none",
            "--env",
            "EXPECTED_SHA=" + sha,
            "--entrypoint",
            "python",
            image_id,
            "-",
        ],
        source=(root / "codex-gateway/tests/image_probe.py").read_bytes(),
    )
else:
    identity = json.loads(
        subprocess.check_output(
            [
                "docker",
                "run",
                "--rm",
                "--platform",
                "linux/amd64",
                "--pull",
                "never",
                "--network",
                "none",
                image_id,
                "identity",
            ]
        )
    )
    if identity["source_sha"] != sha:
        raise ValueError(
            "Platform's installed source identity differs from its declared archive"
        )
    run(
        [
            "docker",
            "run",
            "--rm",
            "--platform",
            "linux/amd64",
            "--pull",
            "never",
            "--network",
            "none",
            "--entrypoint",
            "python",
            image_id,
            "-c",
            "import personal_cloud.status_daemon.server, personal_cloud.observer.cli, pydantic_core",
        ]
    )
    run(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "--platform",
            "linux/amd64",
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "65534:10001",
            "--tmpfs",
            "/run/observer-systemd:rw,size=65536,uid=65534,gid=10001,mode=0770",
            "--entrypoint",
            "python",
            image_id,
            "-",
        ],
        source=(root / "tools/platform-build/smoke_systemd.py").read_bytes(),
    )
