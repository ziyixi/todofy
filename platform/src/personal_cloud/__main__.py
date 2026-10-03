"""Commands for the deployment daemon and observer in the shared OCI image."""

import argparse


def main():
    parser = argparse.ArgumentParser(prog="personal-cloud")
    parser.add_argument("command", choices=("observer", "status-daemon", "identity"))
    args = parser.parse_args()
    if args.command == "identity":
        import json

        from .status_daemon.adapters import baked_source_sha

        sha = baked_source_sha()
        if sha is None:
            return 1
        print(json.dumps({"source_sha": sha}, separators=(",", ":")))
        return 0
    if args.command == "observer":
        from .observer.cli import main as run
    else:
        from .status_daemon.server import main as run
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
