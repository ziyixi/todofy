"""Copy existing Bazel-generated modules into a tree with their source and output hashes."""

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--typescript", type=Path, required=True)
    parser.add_argument("--python", action="append", default=[])
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    outputs = {}
    for path in sorted(args.typescript.rglob("*.ts")):
        relative = path.relative_to(args.typescript)
        if len(relative.parts) < 2:
            continue  # Root files are handwritten runtime modules.
        target = args.out / "ts" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        outputs["ts/" + relative.as_posix()] = digest(target)
    for item in args.python:
        name, filename = item.split("=", 1)
        target = args.out / "py" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(filename, target)
        outputs["python/src/ziyixi_proto/" + name] = digest(target)
    inputs = {}
    for item in args.input:
        name, filename = item.split("=", 1)
        inputs[name] = digest(Path(filename))
    manifest = {"version": 2, "inputs": dict(sorted(inputs.items())), "outputs": dict(sorted(outputs.items()))}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
