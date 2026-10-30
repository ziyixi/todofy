"""Run the original lint/breaking mutation cases with declared tools and local proto sources."""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--buf", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--retired", type=Path, required=True)
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--source", nargs="+", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="proto-rules-") as directory:
        root = Path(directory)
        for source in args.source:
            name = source.as_posix()
            if "/_virtual_imports/" in name:
                name = name.split("/_virtual_imports/", 1)[1].split("/", 1)[1]
            marker = "google/" if "google/" in name else "proto/"
            relative = name[name.index(marker) :].removeprefix("proto/") if marker in name else name
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        text = args.config.read_text()
        config = yaml.safe_load(text)
        if "ignore" in config["lint"]:
            raise ValueError("Adapt the local dependency lint exclusion to the authoritative config")
        # Keep the exact breaking section: the stdlib wire checker reads its formatted ignore list.
        text = re.sub(r"(?ms)^deps:\n.*?(?=^lint:)", "", text)
        text = text.replace("lint:\n", "lint:\n  ignore:\n    - google\n", 1)
        (root / "buf.yaml").write_text(text)
        (root / "buf.lock").write_text("version: v2\n")
        shutil.copyfile(args.retired, root / "retired.json")
        (root / "scripts").mkdir()
        shutil.copyfile(args.script, root / "scripts/rules-selftest.sh")
        tools = root / "tools"
        tools.mkdir()
        for name in ["retired.py", "profile_breaking.py", "wire_rules.py", "reviewed-rules.json"]:
            source = args.config.parent / ("reviewed-rules.json" if name.endswith(".json") else "tools/" + name)
            shutil.copyfile(source, tools / name)
        # profile_breaking locates the reviewed rules beside the module, as production does.
        shutil.copyfile(tools / "reviewed-rules.json", root / "reviewed-rules.json")
        env = dict(os.environ, PROTO_BUF=str(args.buf.resolve()), PROTO_PYTHON=sys.executable)
        env.setdefault("BAZEL_BINDIR", ".")
        env["JS_BINARY__NO_CD_BINDIR"] = "1"
        subprocess.run(["sh", str(root / "scripts/rules-selftest.sh")], check=True, env=env)
