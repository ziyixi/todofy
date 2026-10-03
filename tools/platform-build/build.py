#!/usr/bin/env python3
"""Prepare a minimal OCI build context with the generated shared proto runtime."""

import argparse
import importlib.util
import json
import re
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def proto_backend():
    """Reuse the shared package's production boundary."""
    spec = importlib.util.spec_from_file_location(
        "shared_proto_build", ROOT / "proto/python/build_backend.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(sha: str, output: Path) -> None:
    """Copy only reviewed sources and generated contracts, without data or credentials."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("A full source SHA is required")
    subprocess.run(["node", str(ROOT / "proto/tools/ensure.mjs")], check=True)
    raw = subprocess.check_output(
        ["kubectl", "kustomize", str(ROOT / "platform/k3s/newsletter")],
        text=True,
    )
    resources = {
        "apiVersion": "v1",
        "kind": "List",
        "items": list(yaml.safe_load_all(raw)),
    }
    output.mkdir(parents=True, exist_ok=False)
    backend = proto_backend()
    for source in (ROOT / "platform/src", ROOT / "proto/python/src"):
        for path in sorted(source.rglob("*.py")):
            if path.is_symlink() or not path.is_file():
                raise ValueError("Unexpected image source")
            relative = path.relative_to(source)
            if (
                relative.parts[0] == "ziyixi_proto"
                and len(relative.parts) > 1
                and relative.parts[1] in backend.TEST_ONLY_PACKAGES
            ):
                continue
            target = output / "app" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
    identity = json.dumps({"source_sha": sha}) + "\n"
    (output / "build-info.json").write_text(identity)
    (output / "app/personal_cloud/build-info.json").write_text(identity)
    (output / "app/personal_cloud/resources.json").write_text(
        json.dumps(resources, sort_keys=True) + "\n"
    )
    # A minimal Docker context excludes repository data, private config and build caches.
    for relative in (
        "platform/pyproject.toml",
        "platform/uv.lock",
        "proto/python/pyproject.toml",
    ):
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / relative).read_bytes())
    (output / "Dockerfile").write_bytes((ROOT / "platform/Dockerfile").read_bytes())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.sha, args.output)
