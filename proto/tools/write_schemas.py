"""Materialize already generated Bazel schemas at their published contract paths."""

import argparse
import os
import shutil
import sys
from pathlib import Path

from gen_schema import SCHEMAS

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("schemas", nargs="+", type=Path)
    args = parser.parse_args()
    generated = {path.name: path for path in args.schemas}
    expected = {Path(target.path).name: target for target in SCHEMAS}
    if generated.keys() != expected.keys():
        raise SystemExit("Generated and published schema sets differ")
    proto = Path(os.environ["BUILD_WORKSPACE_DIRECTORY"]) / "proto"
    followups = []
    for name, target in expected.items():
        destination = proto / target.path
        if not destination.exists() or destination.read_bytes() != generated[name].read_bytes():
            shutil.copyfile(generated[name], destination)
            if target.then and target.then not in followups:
                followups.append(target.then)
    if followups:
        print("gen_schema: then regenerate what copies the changed schemas: " + "; ".join(followups), file=sys.stderr)
    print(f"{len(expected)} Bazel-generated schemas materialized")
