"""Run schema lint and API lint with Bazel's pinned tools and descriptor image."""

import argparse
from pathlib import Path
import subprocess
import tempfile


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("lint", "format", "api-lint"))
    parser.add_argument("--buf", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--api-linter")
    parser.add_argument("--googleapis-check")
    parser.add_argument("--source", action="append", default=[])
    args = parser.parse_args()
    if args.mode == "format":
        subprocess.run([args.buf, "format", str(args.config.parent), "--diff", "--exit-code"], check=True)
    elif args.mode == "lint":
        subprocess.run([args.buf, "lint", str(args.image), "--config", str(args.config)], check=True)
    else:
        subprocess.run([args.googleapis_check, str(args.image)], check=True)
        with tempfile.TemporaryDirectory(prefix="proto-api-lint-") as temporary:
            report = Path(temporary) / "report.yaml"
            result = subprocess.run([
                args.api_linter, "--descriptor-set-in", str(args.image),
                "--output-format", "yaml", "--output-path", str(report), "--set-exit-status",
                *(source for source in args.source if not source.startswith("prototest/")),
            ])
            if result.returncode:
                if report.exists():
                    print(report.read_text(encoding="utf-8"))
                raise SystemExit(result.returncode)
        print("api-linter: no problems")
