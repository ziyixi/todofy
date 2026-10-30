"""Every declared generation input must invalidate uv's cached local wheel."""

import argparse
import json
import posixpath
import tomllib
from pathlib import Path, PurePosixPath

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    project = tomllib.loads(args.project.read_text())
    # Compare logical workspace paths; UV resolves cache-key patterns from proto/python.
    patterns = [
        posixpath.normpath("/workspace/proto/python/" + key["file"]) for key in project["tool"]["uv"]["cache-keys"]
    ]
    missing = []
    for name in manifest["inputs"]:
        source = PurePosixPath(posixpath.normpath("/workspace/proto/" + name))
        if not any(source.full_match(pattern) for pattern in patterns):
            missing.append(name)
    if missing:
        raise SystemExit("UV cache keys omit declared generation inputs: " + ", ".join(sorted(missing)))
    print(f"UV cache keys cover {len(manifest['inputs'])} declared generation inputs")
