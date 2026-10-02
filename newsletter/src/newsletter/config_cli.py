"""Build and validate bundles offline, without providers or service state."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import newsletter.content_config as content_config


def main(argv: list[str] | None = None) -> int:
    """Build or validate a bundle without opening service or provider state."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--source", type=pathlib.Path, required=True)
    build.add_argument("--revision", required=True)
    build.add_argument("--output", type=pathlib.Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("--bundle", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            snapshot = content_config.build_directory(
                args.source, args.revision
            )
            content_config.write_snapshot(args.output, snapshot)
        else:
            snapshot = content_config.read_snapshot(args.bundle)
    except (OSError, ValueError, UnicodeError, RecursionError):
        print("CONTENT_CONFIG_INVALID", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {key: snapshot[key] for key in ("revision", "digest", "editorial")}
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
