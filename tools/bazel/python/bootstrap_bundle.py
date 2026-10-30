"""Call the existing bootstrap renderer on exactly the declared public sources."""

import argparse
import importlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--manifest", type=Path, required=True)
parser.add_argument("--images", type=Path, required=True)
parser.add_argument("--status", type=Path, required=True)
parser.add_argument("--kubectl", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
status = dict(line.split(" ", 1) for line in args.status.read_text().splitlines())
sha = status.get("BUILD_EMBED_LABEL", "")
if not re.fullmatch(r"[0-9a-f]{40}", sha) or sha == "0" * 40:
    raise ValueError(
        "Bootstrap bundles require --embed_label=<nonzero-full-source-SHA>"
    )
images = {
    name: value for name, value in json.loads(args.images.read_text()).items() if value
}
with tempfile.TemporaryDirectory(prefix="bootstrap-bundle-") as temporary:
    root = Path(temporary).resolve() / "source"
    for relative in json.loads(args.manifest.read_text()):
        source = Path(relative)
        if source.is_absolute() or ".." in source.parts:
            raise ValueError("Bootstrap inputs must be declared workspace sources")
        destination = root / source
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    binaries = Path(temporary) / "bin"
    binaries.mkdir()
    (binaries / "kubectl").symlink_to(args.kubectl.absolute())
    os.environ["PATH"] = str(binaries) + os.pathsep + os.defpath
    sys.path[:0] = [
        str(root / folder)
        for folder in ("tools/vps-bootstrap", "tools/vps-release", "tools/cloud-config")
    ]
    prepare = importlib.import_module("prepare")
    bundle = Path(temporary) / "bundle"
    prepare.prepare(root, sha, images, bundle)
    shutil.copytree(bundle, args.out, dirs_exist_ok=True)
