"""Run the pinned manifest compiler on the declared Platform resources."""

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubectl", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, action="append", default=[])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    # Kustomize's filesystem loader needs regular files, not sandbox input links.
    with tempfile.TemporaryDirectory(prefix="platform-manifests-") as temporary:
        root = Path(temporary)
        for source in args.manifest:
            shutil.copyfile(source, root / source.name)
        raw = subprocess.check_output(
            [str(args.kubectl.resolve()), "kustomize", str(root)]
        )
    resources = {
        "apiVersion": "v1",
        "kind": "List",
        "items": list(yaml.safe_load_all(raw)),
    }
    args.out.write_text(json.dumps(resources, sort_keys=True) + "\n")
