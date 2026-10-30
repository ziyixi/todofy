"""Bake Newsletter's existing source and public console policy into its image."""

import argparse
import json
import re
from pathlib import Path

from newsletter.console_access import write_policy

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    args = parser.parse_args()
    status = dict(line.split(" ", 1) for line in args.status.read_text().splitlines())
    sha = status.get("BUILD_EMBED_LABEL", "")
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("Build the image with --embed_label=<full-source-SHA>")
    output = args.out / "opt/newsletter"
    output.mkdir(parents=True)
    (output / "build-info.json").write_text(json.dumps({"source_sha": sha}))
    write_policy(args.profile.parent, output / "console-access.json")
    args.labels.write_text(
        "org.opencontainers.image.source=https://github.com/ziyixi/todofy\n"
        f"org.opencontainers.image.revision={sha}\n"
    )
