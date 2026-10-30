"""Retain Newsletter's Docker HEALTHCHECK without rebuilding image layers."""

import argparse
import hashlib
import json
import os
import shlex
import shutil
from pathlib import Path


def healthcheck(dockerfile: Path) -> dict:
    line = next(
        line
        for line in dockerfile.read_text().splitlines()
        if line.startswith("HEALTHCHECK ")
    )
    options, command = line.split(" CMD ", 1)
    flags = dict(
        option.removeprefix("--").split("=", 1) for option in shlex.split(options)[1:]
    )
    if flags.keys() != {"interval", "timeout", "start-period"}:
        raise ValueError(
            "Newsletter HEALTHCHECK options changed; review the image adapter"
        )
    return {
        "Test": ["CMD-SHELL", command],
        "Interval": int(flags["interval"].removesuffix("s")) * 1_000_000_000,
        "Timeout": int(flags["timeout"].removesuffix("s")) * 1_000_000_000,
        "StartPeriod": int(flags["start-period"].removesuffix("s")) * 1_000_000_000,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--dockerfile", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--digest", type=Path, required=True)
    args = parser.parse_args()
    shutil.copytree(
        args.base,
        args.out,
        copy_function=lambda source, dest: os.link(Path(source).resolve(), dest),
        dirs_exist_ok=True,
    )
    args.out.chmod(0o755)
    blobs = args.out / "blobs" / "sha256"
    blobs.chmod(0o755)

    def read_blob(digest: str) -> dict:
        return json.loads(
            (args.out / "blobs" / digest.replace(":", "/", 1)).read_text()
        )

    def write_blob(value: dict) -> tuple[str, int]:
        content = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(content).hexdigest()
        (blobs / digest).write_bytes(content)
        return "sha256:" + digest, len(content)

    index = json.loads((args.out / "index.json").read_text())
    manifest = read_blob(index["manifests"][0]["digest"])
    config = read_blob(manifest["config"]["digest"])
    config["config"]["Healthcheck"] = healthcheck(args.dockerfile)
    manifest["config"]["digest"], manifest["config"]["size"] = write_blob(config)
    image_digest, size = write_blob(manifest)
    index["manifests"][0].update(digest=image_digest, size=size)
    # index.json was hardlinked to the input. Replace it without mutating that input.
    (args.out / "index.json").unlink()
    (args.out / "index.json").write_text(
        json.dumps(index, sort_keys=True, separators=(",", ":"))
    )
    args.digest.write_text(image_digest + "\n")
