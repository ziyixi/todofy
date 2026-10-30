"""Execute one compatible group from the current SHA's Bazel plan."""

import argparse
import json
import subprocess
import tempfile
from collections.abc import Sequence
from pathlib import Path

from plan import GROUPS


def command(
    bazel: str, group: str, patterns: str, cache: Path, startup: Sequence[str] = ()
) -> list[str]:
    args = [
        bazel,
        *startup,
        "test",
        "--build_tests_only",
        "--target_pattern_file=" + patterns,
        "--repository_cache=" + str(cache / "repository"),
        "--disk_cache=" + str(cache / "actions"),
    ]
    args.append(
        "--local_test_jobs=" + ("1" if group in ("workerd", "cpu", "browser") else "4")
    )
    if group == "cpu":
        args.append("--nocache_test_results")
    return args


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", default="bazel")
    parser.add_argument("--bazel-startup-option", action="append", default=[])
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--group", choices=GROUPS, required=True)
    args = parser.parse_args()
    targets = json.loads(args.plan.read_text())["groups"].get(args.group, [])
    if not targets:
        raise SystemExit("The selected group has no targets")
    with tempfile.TemporaryDirectory(prefix="bazel-targets-") as temporary:
        patterns = Path(temporary) / "targets.txt"
        patterns.write_text("\n".join(targets) + "\n", encoding="utf-8")
        subprocess.run(
            command(
                args.bazel,
                args.group,
                str(patterns),
                Path.home() / ".cache/personal-cloud-bazel",
                args.bazel_startup_option,
            ),
            check=True,
        )
