"""Compare Bazel's current IDL image with a concrete Git base, including retirement and wire rules."""

import argparse
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile

import profile_breaking
import retired


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--buf", required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--retired", type=Path, required=True)
    parser.add_argument("base", help="A commit; an empty argument uses HEAD~1, as the existing CI gate does")
    args = parser.parse_args()
    workspace = os.environ["BUILD_WORKSPACE_DIRECTORY"]
    base = args.base or "HEAD~1"
    if not args.base:
        print("note: no base commit was given; comparing with HEAD~1 only")
    revision = subprocess.check_output(
        ["git", "-C", workspace, "rev-parse", "--verify", f"{base}^{{commit}}"], text=True,
    ).strip()
    present = subprocess.run(["git", "-C", workspace, "cat-file", "-e", f"{revision}:proto/buf.yaml"])
    if present.returncode:
        print(f"skipped: {revision} predates proto/")
        raise SystemExit(0)
    with tempfile.TemporaryDirectory(prefix="proto-breaking-") as temporary:
        root = Path(temporary)
        archive = subprocess.check_output(["git", "-C", workspace, "archive", revision, "proto"])
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            members = [member for member in source if member.name.endswith(".proto") or member.name in ("proto/buf.yaml", "proto/buf.lock")]
            source.extractall(root, members=members, filter="data")
        published, head, against = (root / name for name in ("published.json", "head.json", "against.json"))
        for source, destination in [(str(root / "proto"), published), (str(args.image), head)]:
            subprocess.run([
                args.buf, "build", source, "--exclude-source-info", "-o", f"{destination}#format=json",
            ], check=True)
        if retired.main(["retired.py", str(args.retired), str(published), str(head), str(against)]):
            raise SystemExit(1)
        subprocess.run([
            args.buf, "breaking", str(args.image), "--against", f"{against}#format=json",
            "--config", str(args.config),
        ], check=True)
        if profile_breaking.main([str(against), str(head), "--config", str(args.config)]):
            raise SystemExit(1)
    print(f"proto/: no breaking change against {revision}")
