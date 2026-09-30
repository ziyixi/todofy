#!/usr/bin/env python3
"""Split a pytest suite into shards of whole test files. Standard library only (the runner's python3).

    python3 pytest_shards.py --collected ids.txt --durations durations.json --index I --total N [--workers W]
        [--serial serial.txt --serial-out FILE]

``ids.txt`` is the output of ``pytest <paths> --collect-only -q``: every line containing "::" is a test
id and its file part is a file to plan. Prints the files of shard ``I`` (0-based, as GitHub's
``strategy.job-index``) of ``N`` that run under pytest-xdist, one per line, heaviest first.

- The unit is a whole file, never a test: the Todofy runtime modules share one Worker per module and
  some tests rely on the ones before them (todofy/conftest.py), so a file must run whole, in
  its own order, in one process. A shard runs its files with pytest-xdist ``--dist loadfile
  --no-loadscope-reorder`` in ``W`` processes: xdist hands whole files out in the order pytest collected
  them, which is the order of the paths on the command line, so heaviest first.
- Files are independent of each other (the order experiments in docs/dev-notes.md §1), so the order
  of the files only changes the wall time.
- Weights are the recorded seconds per file in ``durations.json`` ({"tests/runtime/test_x.py": 12.3});
  a file without one (a new file) weighs the mean of the recorded ones, so it is always planned. Stale
  weights only change the balance, never what runs.
- Longest-processing-time first over ``N * W`` lanes (one per process): files by weight, heaviest first
  (ties by path), each to the lightest lane so far (ties by lowest index); lane ``L`` belongs to shard
  ``L mod N``, so equal lanes fill the shards in turn. Deterministic for the same inputs.
- ``serial.txt`` lists files (one path per line, "#" comments) that must run alone, with no other test
  server on the machine: the shard runs them in one plain pytest process after its xdist run, and
  ``--serial-out`` receives this shard's share (possibly empty). They stay out of the lanes; each goes,
  heaviest first, to the shard with the least work so far (its lanes' mean plus its serial files). A
  listed file that pytest did not collect is refused, so a rename cannot drop it from the serial run.
- Refuses (exit 1) an index outside 0..N-1, a plan with an empty shard (pytest would collect nothing and
  exit 5), or a plan whose shards do not cover every file exactly once.

``--plan`` prints every shard with its weight instead (for humans and the docs).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def collected_files(lines: list[str]) -> list[str]:
    """The distinct files of the test ids in ``pytest --collect-only -q`` output, sorted."""
    return sorted({line.strip().split("::", 1)[0] for line in lines if "::" in line})


def weights(files: list[str], durations: dict[str, float]) -> dict[str, float]:
    recorded = [float(seconds) for seconds in durations.values()]
    default = sum(recorded) / len(recorded) if recorded else 1.0
    return {path: float(durations.get(path, default)) for path in files}


def heaviest_first(files: list[str], weight: dict[str, float]) -> list[str]:
    return sorted(files, key=lambda path: (-weight[path], path))


def plan(files: list[str], durations: dict[str, float], total: int, workers: int = 1) -> list[list[str]]:
    """``total`` shards of whole files, each heaviest first; raises ValueError if one would be empty."""
    if total < 1 or workers < 1:
        raise ValueError(f"total and workers must be at least 1, not {total} and {workers}")
    weight = weights(files, durations)
    shards: list[list[str]] = [[] for _ in range(total)]
    lanes = [0.0] * (total * workers)
    for path in heaviest_first(files, weight):
        lightest = min(range(len(lanes)), key=lambda lane: (lanes[lane], lane))
        shards[lightest % total].append(path)
        lanes[lightest] += weight[path]
    if any(not shard for shard in shards):
        raise ValueError(f"{len(files)} files cannot fill {total} shards")
    planned = [path for shard in shards for path in shard]
    if sorted(planned) != sorted(files) or len(planned) != len(set(planned)):
        raise ValueError("the shards do not cover every file exactly once")
    return [heaviest_first(shard, weight) for shard in shards]


def listed_files(text: str) -> list[str]:
    """The paths in a list file: one per line, "#" starts a comment."""
    lines = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return [line for line in lines if line]


def place_serial(
    shards: list[list[str]], serial: list[str], durations: dict[str, float], workers: int
) -> list[list[str]]:
    """Each serial file (heaviest first) to the shard with the least work so far: its xdist files' seconds
    over ``workers`` plus the serial files it already has (ties by lowest index). Deterministic."""
    weight = weights(sorted({*serial, *(path for shard in shards for path in shard)}), durations)
    load = [sum(weight[path] for path in shard) / workers for shard in shards]
    placed: list[list[str]] = [[] for _ in shards]
    for path in heaviest_first(sorted(set(serial)), weight):
        lightest = min(range(len(shards)), key=lambda index: (load[index], index))
        placed[lightest].append(path)
        load[lightest] += weight[path]
    return placed


def plan_with_serial(
    files: list[str], durations: dict[str, float], total: int, workers: int, serial: list[str]
) -> tuple[list[list[str]], list[list[str]]]:
    """(xdist files, serial files) per shard; every file in exactly one of them, in exactly one shard."""
    missing = sorted(set(serial) - set(files))
    if missing:
        raise ValueError(f"serial files that pytest did not collect: {missing}")
    shards = plan([path for path in files if path not in set(serial)], durations, total, workers)
    placed = place_serial(shards, serial, durations, workers)
    everything = [path for group in (*shards, *placed) for path in group]
    if sorted(everything) != sorted(files) or len(everything) != len(set(everything)):
        raise ValueError("the shards do not cover every file exactly once")
    return shards, placed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--collected", type=Path, required=True)
    parser.add_argument("--durations", type=Path, required=True)
    parser.add_argument("--total", type=int, required=True)
    parser.add_argument("--workers", type=int, default=1, help="pytest-xdist processes per shard")
    parser.add_argument("--index", type=int)
    parser.add_argument("--plan", action="store_true", help="print every shard with its weight")
    parser.add_argument("--serial", type=Path, help="files that run alone, after the shard's xdist run")
    parser.add_argument("--serial-out", type=Path, help="where to write this shard's serial files")
    args = parser.parse_args(argv)

    files = collected_files(args.collected.read_text().splitlines())
    durations = json.loads(args.durations.read_text())
    serial = listed_files(args.serial.read_text()) if args.serial else []
    try:
        if not files:
            raise ValueError(f"no test ids in {args.collected}")
        if serial and not (args.serial_out or args.plan):
            raise ValueError("--serial needs --serial-out: the serial files must be run")
        shards, placed = plan_with_serial(files, durations, args.total, args.workers, serial)
        if args.plan:
            weight = weights(files, durations)
            for index, shard in enumerate(shards):
                alone = placed[index]
                load = sum(weight[path] for path in shard)
                tail = sum(weight[path] for path in alone)
                print(
                    f"shard {index}: {load:.1f} s in {len(shard)} files ({load / args.workers:.1f} s per process)"
                    + (f", then {tail:.1f} s alone in {len(alone)} files" if alone else "")
                )
                for path in shard:
                    print(f"  {path} ({weight[path]:.1f} s)")
                for path in alone:
                    print(f"  {path} ({weight[path]:.1f} s, alone)")
            return 0
        if args.index is None or not 0 <= args.index < args.total:
            raise ValueError(f"index must be in 0..{args.total - 1}, not {args.index}")
    except ValueError as error:
        print(f"pytest_shards: {error}", file=sys.stderr)
        return 1
    if args.serial_out:
        args.serial_out.write_text("".join(f"{path}\n" for path in placed[args.index]))
    print("\n".join(shards[args.index]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
