"""Execute one compatible group from the current SHA's Bazel plan."""

import argparse
import json
import subprocess
import tempfile
from collections.abc import Sequence
from pathlib import Path

from plan import GROUPS, cache_family

# Main saves each family's action cache again, so this bounds every entry in the 10 GB quota.
DISK_CACHE_LIMIT = 1536 * 1024 * 1024


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
        "--local_test_jobs="
        + (
            "1"
            if cache_family(group) in ("workerd", "cpu", "browser", "container")
            else "4"
        )
    )
    if group == "cpu":
        args.append("--nocache_test_results")
    return args


def collect_garbage(directory: Path, limit: int = DISK_CACHE_LIMIT) -> None:
    """Drop the least recently used files first, as Bazel's size-based disk cache GC does."""
    entries = []
    for path in directory.rglob("*"):
        if path.is_file():
            status = path.stat()
            entries.append((status.st_mtime, status.st_size, path))
    total = sum(size for _, size, _ in entries)
    for _, size, path in sorted(entries):
        if total <= limit:
            break
        path.unlink()
        total -= size


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
    cache = Path.home() / ".cache/personal-cloud-bazel"
    with tempfile.TemporaryDirectory(prefix="bazel-targets-") as temporary:
        patterns = Path(temporary) / "targets.txt"
        patterns.write_text("\n".join(targets) + "\n", encoding="utf-8")
        subprocess.run(
            command(
                args.bazel, args.group, str(patterns), cache, args.bazel_startup_option
            ),
            check=True,
        )
    # Bazel's own GC runs only once its server is idle and shutdown interrupts it, so the
    # stopped server leaves the cache to this deterministic pass before Actions saves it.
    subprocess.run([args.bazel, *args.bazel_startup_option, "shutdown"], check=True)
    collect_garbage(cache / "actions")
