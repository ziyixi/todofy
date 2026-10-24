"""Prepare only application code and generated contracts for the OCI build."""

import argparse
import json
import shutil
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    app = Path(__file__).resolve().parents[1]
    root = app.parent
    subprocess.run(["node", str(root / "proto/tools/ensure.mjs")], cwd=root, check=True)
    destination = args.output.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    shutil.copytree(
        app / "src/mailsort_runner",
        destination / "app/mailsort_runner",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    shutil.copytree(
        root / "proto/python/src/ziyixi_proto",
        destination / "app/ziyixi_proto",
        ignore=shutil.ignore_patterns("__pycache__", "prototest"),
    )
    (destination / "mailsort-runner").mkdir()
    for name in ("pyproject.toml", "uv.lock"):
        shutil.copyfile(app / name, destination / "mailsort-runner" / name)
    (destination / "proto/python").mkdir(parents=True)
    shutil.copyfile(
        root / "proto/python/pyproject.toml", destination / "proto/python/pyproject.toml"
    )
    shutil.copyfile(app / "Dockerfile", destination / "Dockerfile")
    (destination / "build-info.json").write_text(json.dumps({"source_sha": args.sha}) + "\n")


if __name__ == "__main__":
    main()
