"""Bake the existing public gateway identity in the final image layer."""

import argparse
import json
import re
import tomllib
from pathlib import Path

from codex_gateway.access import AccessServiceVerifier

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    args = parser.parse_args()
    status = dict(line.split(" ", 1) for line in args.status.read_text().splitlines())
    sha = status.get("BUILD_EMBED_LABEL") or "0" * 40
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("Build the image with --embed_label=<full-source-SHA>")
    profile = tomllib.loads(args.profile.read_text())
    resources = tomllib.loads(args.resources.read_text())
    issuer = profile["access_issuer"]
    audience = resources["access_audiences"]["codex-gateway"]
    AccessServiceVerifier(issuer, audience)
    output = args.out / "opt/codex-gateway/app/codex_gateway/build-info.json"
    output.parent.mkdir(parents=True)
    output.write_text(
        json.dumps(
            {"source_sha": sha, "access_issuer": issuer, "access_audience": audience}
        )
    )
    args.labels.write_text(
        "org.opencontainers.image.source=https://github.com/ziyixi/todofy\n"
        f"org.opencontainers.image.revision={sha}\n"
    )
