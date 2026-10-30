"""Bake the Platform source identity into the final image layer."""

import argparse
import json
import re
from pathlib import Path

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    args = parser.parse_args()
    status = dict(line.split(" ", 1) for line in args.status.read_text().splitlines())
    sha = status.get("BUILD_EMBED_LABEL") or "0" * 40
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("Build the image with --embed_label=<full-source-SHA>")
    content = json.dumps({"source_sha": sha}) + "\n"
    root = args.out / "opt/personal-cloud"
    (root / "app/personal_cloud").mkdir(parents=True)
    (root / "build-info.json").write_text(content)
    (root / "app/personal_cloud/build-info.json").write_text(content)
    args.labels.write_text(
        "org.opencontainers.image.source=https://github.com/ziyixi/todofy\n"
        f"org.opencontainers.image.revision={sha}\n"
    )
