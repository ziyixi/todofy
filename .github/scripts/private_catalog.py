"""Generate a private catalogue from the selected parent's exact gitlink, without public output."""

import argparse
import re
import subprocess
import sys
from pathlib import Path

SOURCE_ERROR = "PRIVATE_CATALOG_SOURCE_INVALID"
GENERATION_ERROR = "PRIVATE_CATALOG_GENERATION_FAILED"


def git(root, *arguments):
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise ValueError(SOURCE_ERROR)
    return result.stdout.strip()


def revision(root):
    entry = git(root, "ls-tree", "HEAD", "private")
    match = re.fullmatch(r"160000 commit ([0-9a-f]{40})\tprivate", entry)
    if match is None:
        raise ValueError(SOURCE_ERROR)
    return match[1]


def generate(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    if git(root / "private", "rev-parse", "HEAD") != revision(root):
        raise ValueError(SOURCE_ERROR)
    if output.exists():
        raise ValueError(GENERATION_ERROR)
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(root / "private/ci/release.py"),
                "--operation",
                "catalog",
                "--output",
                str(output),
            ],
            cwd=root,
            capture_output=True,
            check=False,
        )
        if (
            result.returncode
            or not output.is_file()
            or (output.stat().st_mode & 0o777) != 0o600
        ):
            raise ValueError(GENERATION_ERROR)
    except Exception:
        output.unlink(missing_ok=True)
        raise ValueError(GENERATION_ERROR) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("revision", "generate"))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.operation == "revision":
        if args.output:
            raise ValueError(SOURCE_ERROR)
        print("revision=" + revision(args.source_root))
    else:
        if not args.output:
            raise ValueError(GENERATION_ERROR)
        generate(args.source_root, args.output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error)
        sys.exit(
            code
            if isinstance(error, ValueError)
            and code in {SOURCE_ERROR, GENERATION_ERROR}
            else GENERATION_ERROR
        )
