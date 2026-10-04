#!/usr/bin/env python3
"""Public deployment URLs for CI; no credentials or provider requests."""

import argparse
import json
import sys
from pathlib import Path

from cloud_profile import ProfileError, deployment_urls, load_profile

REPO = Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--github-output", type=Path, help="Append public key=value outputs to this Actions file")
    args = parser.parse_args(argv)
    try:
        urls = deployment_urls(load_profile(REPO))
        if args.github_output:
            with args.github_output.open("a", encoding="utf-8") as handle:
                for name, value in urls.items():
                    handle.write(f"{name}={value}\n")
        else:
            print(json.dumps(urls, sort_keys=True))
        return 0
    except (ProfileError, OSError) as error:
        print(str(error) if isinstance(error, ProfileError) else "Cannot write deployment outputs", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
