"""Build a checked-out service revision with Bazel and load its tested image."""

import argparse
import json
import re
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ("newsletter", "platform", "codex-gateway")
IMAGE_FORMAT = (
    '{"id":{{json .Id}},'
    '"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},'
    '"source":{{json (index .Config.Labels "org.opencontainers.image.source")}}}'
)


def build(service: str, sha: str) -> dict[str, str]:
    """Build one real checkout identity before handing it to the existing probes."""
    if (
        service not in SERVICES
        or not re.fullmatch(r"[0-9a-f]{40}", sha)
        or sha == "0" * 40
    ):
        raise ValueError("A service and a real, full source SHA are required")
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    if head != sha:
        raise ValueError("The source SHA must match the checked-out HEAD")
    version = (ROOT / ".bazelversion").read_text().strip()
    if (
        subprocess.check_output(
            ["bazel", "version", "--gnu_format"], cwd=ROOT, text=True
        ).strip()
        != "bazel " + version
    ):
        raise ValueError("Bazel must match the repository's fixed version")
    cache = Path.home() / ".cache/personal-cloud-bazel"
    options = [
        "--platforms=//tools/bazel/images:linux_amd64",
        "--embed_label=" + sha,
        "--repository_cache=" + str(cache / "repository"),
        "--disk_cache=" + str(cache / "actions"),
    ]
    target = f"//{service}"
    subprocess.run(["bazel", "build", target, *options], cwd=ROOT, check=True)
    outputs = subprocess.check_output(
        ["bazel", "cquery", target, *options, "--output=files"], cwd=ROOT, text=True
    ).splitlines()
    if len(outputs) != 1:
        raise ValueError("Bazel must produce exactly one tested image archive")
    archive = ROOT / outputs[0]
    if not archive.is_file():
        raise ValueError("Bazel's tested image archive is missing")
    subprocess.run(["docker", "load", "--input", str(archive)], check=True)
    loaded = json.loads(
        subprocess.check_output(
            [
                "docker",
                "image",
                "inspect",
                "--format",
                IMAGE_FORMAT,
                f"todofy-{service}:bazel",
            ],
            text=True,
        )
    )
    profile = tomllib.loads((ROOT / "config/cloud.toml").read_text())
    source = "https://github.com/" + profile["repository"]
    if (
        not re.fullmatch(r"sha256:[0-9a-f]{64}", loaded.get("id", ""))
        or loaded.get("revision") != sha
        or loaded.get("source") != source
    ):
        raise ValueError("The loaded Bazel image identity does not match the checkout")
    tag = f"{service}-ci:{sha}"
    subprocess.run(["docker", "tag", loaded["id"], tag], check=True)
    return {"source_sha": sha, "service": service, "image_id": loaded["id"], "tag": tag}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", choices=SERVICES, required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.service, args.sha), sort_keys=True))
