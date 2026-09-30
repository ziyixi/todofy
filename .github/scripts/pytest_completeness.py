#!/usr/bin/env python3
"""Prove that a sharded pytest run ran every collected test exactly once. Standard library only.

    python3 pytest_completeness.py --collected ids.txt --junit-dir DIR --shards N \
        [--test-root tests/runtime] [--serial serial.txt] [--expected-skips skips.txt] \
        [--durations-out durations.json]

``ids.txt`` is ``pytest <paths> --collect-only -q`` of the same commit; ``DIR`` holds the shards' JUnit
XML files (``pytest --junitxml``): ``<name>-<I>.xml`` for shard I's pytest-xdist run and, when the shard
ran files alone (pytest_shards.py --serial), ``<name>-<I>-serial.xml``. Fails (exit 1) unless all of
these hold:

- every shard 0..N-1 has exactly one xdist file and at most one serial file, nothing else is there, and
  none reports a collection error;
- the collection itself is clean: pytest reported no collection error and skipped no whole module
  (``pytest.skip(allow_module_level=True)``, ``importorskip``), and every test file under ``--test-root``
  (``test_*.py``, ``*_test.py``) has at least one collected id, so a file can never vanish from the plan;
- the collected ids are unique and their count matches pytest's "N tests collected" line;
- every collected id ran, exactly once, and nothing else ran;
- no test failed or errored;
- the skipped tests are exactly the ids listed in ``skips.txt`` (one id per line, "#" comments): the
  serial baseline's skips, so the skip count equals the baseline's. A listed test that ran instead
  fails too, until the list is updated;
- the tests of the files in ``serial.txt`` ran only in serial files, and serial files hold nothing else.

JUnit names a test by (classname, name); an id maps to it the way pytest's own junitxml does
(``mangle_test_address``). The mapping is checked to be one-to-one over the collected ids first, so
two ids can never pass as one.

Prints a table per shard, and the seconds per file measured in this run as JSON (the shard planner's
weights: .github/scripts/todofy-runtime-durations.json) to stdout and, on GitHub, to the step
summary; ``--durations-out`` also writes that JSON to a file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ElementTree
from collections import Counter
from pathlib import Path

COLLECTED = re.compile(r"^(\d+) tests? collected")
# What pytest prints about a collector (not a test) that errored or skipped: the "-ra" summary lines of
# addopts, the ERRORS section and the "N tests collected, M errors" line.
COLLECTION_TROUBLE = re.compile(
    r"^(SKIPPED|ERROR|XFAIL|XPASS)\b|^=+ ERRORS =+$|^!+ .*Interrupted|collected.*\berrors?\b"
)
JUNIT_FILE = re.compile(r"^.+-(\d+)(-serial)?\.xml$")


def junit_key(test_id: str) -> tuple[str, str]:
    """(classname, name) of a test id in pytest's JUnit XML (junitxml.mangle_test_address)."""
    path, bracket, params = test_id.partition("[")
    names = path.split("::")
    names[0] = re.sub(r"\.py$", "", names[0].replace("/", "."))
    names[-1] += bracket + params
    return ".".join(names[:-1]), names[-1]


def collected_ids(text: str) -> tuple[list[str], int | None]:
    """The test ids and pytest's own count ("N tests collected"), if printed."""
    ids = [line.strip() for line in text.splitlines() if "::" in line]
    counts = [int(match.group(1)) for line in text.splitlines() if (match := COLLECTED.match(line.strip()))]
    return ids, counts[-1] if counts else None


def expected_skips(path: Path | None) -> set[str]:
    """The lines of a list file ("#" comments), as a set; also reads --serial's file list."""
    if path is None:
        return set()
    lines = (line.split("#", 1)[0].strip() for line in path.read_text().splitlines())
    return {line for line in lines if line}


def collection_trouble(text: str) -> list[str]:
    """pytest's own lines about collectors that errored or skipped a whole module."""
    lines = (line.strip() for line in text.splitlines())
    return [
        line for line in lines if COLLECTION_TROUBLE.search(line) and not ("::" in line and line.startswith("tests"))
    ]


def test_files(root: Path) -> list[str]:
    """The files pytest's default python_files patterns select under ``root``, as ids spell them."""
    found = {*root.rglob("test_*.py"), *root.rglob("*_test.py")}
    return sorted(path.as_posix() for path in found if "__pycache__" not in path.parts)


class Shard:
    def __init__(self, path: Path) -> None:
        self.path = path
        root = ElementTree.parse(path).getroot()
        suites = [root] if root.tag == "testsuite" else root.findall("testsuite")
        self.reported = sum(int(suite.get("tests", "0")) for suite in suites)
        self.errors = sum(int(suite.get("errors", "0")) for suite in suites)
        self.failures = sum(int(suite.get("failures", "0")) for suite in suites)
        self.cases = [case for suite in suites for case in suite.iter("testcase")]


def check(
    collected_text: str,
    junit_files: list[Path],
    shards: int,
    skips: set[str],
    serial: set[str] = frozenset(),
    on_disk: list[str] | None = None,
) -> tuple[list[str], dict[str, float], list[str]]:
    """(problems, seconds per file, summary lines); no problems means the run was complete.

    ``serial`` holds the files that must run alone; ``on_disk`` the test files that must be collected."""
    problems: list[str] = []
    ids, reported = collected_ids(collected_text)
    if not ids:
        problems.append("no collected test ids")
    trouble = collection_trouble(collected_text)
    if trouble:
        problems.append(f"the collection skipped or failed a collector: {trouble}")
    files = {test_id.split("::", 1)[0] for test_id in ids}
    if on_disk is not None:
        uncollected = sorted(set(on_disk) - files)
        if uncollected:
            problems.append(f"test files with no collected test: {uncollected}")
    unknown_serial = sorted(serial - files)
    if unknown_serial:
        problems.append(f"serial files that were not collected: {unknown_serial}")
    if reported is not None and reported != len(ids):
        problems.append(f"pytest collected {reported} tests but listed {len(ids)} ids")
    duplicated = sorted(test_id for test_id, count in Counter(ids).items() if count > 1)
    if duplicated:
        problems.append(f"duplicate collected ids: {duplicated}")
    keys = {test_id: junit_key(test_id) for test_id in ids}
    by_key: dict[tuple[str, str], str] = {}
    for test_id, key in keys.items():
        if key in by_key:
            problems.append(f"{test_id} and {by_key[key]} have the same JUnit name {key}")
        by_key[key] = test_id
    unknown_skips = sorted(skips - set(ids))
    if unknown_skips:
        problems.append(f"expected skips that are not collected: {unknown_skips}")

    runs: Counter[tuple[int, bool]] = Counter()
    for path in junit_files:
        match = JUNIT_FILE.match(path.name)
        if match is None:
            problems.append(f"{path.name} is not a shard's JUnit file (<name>-<index>[-serial].xml)")
        else:
            runs[int(match.group(1)), bool(match.group(2))] += 1
    xdist_runs = sorted(index for (index, alone), count in runs.items() if not alone for _ in range(count))
    if xdist_runs != list(range(shards)):
        problems.append(f"expected one JUnit file per shard 0..{shards - 1}, found shards {xdist_runs}")
    for (index, alone), count in sorted(runs.items()):
        if alone and (count > 1 or not 0 <= index < shards):
            problems.append(f"expected at most one serial JUnit file for shard {index} of {shards}, found {count}")
    ran: Counter[tuple[str, str]] = Counter()
    skipped: set[str] = set()
    seconds: dict[str, float] = {}
    summary = [
        "| JUnit file | tests | failed | errors | skipped | seconds |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for path in sorted(junit_files):
        shard = Shard(path)
        skipped_here = failed_here = errored_here = 0
        shard_seconds = 0.0
        alone = bool((match := JUNIT_FILE.match(path.name)) and match.group(2))
        for case in shard.cases:
            key = (case.get("classname", ""), case.get("name", ""))
            ran[key] += 1
            test_id = by_key.get(key, f"{key[0]}::{key[1]}")
            if key in by_key and (test_id.split("::", 1)[0] in serial) != alone:
                where = "a serial" if alone else "an xdist"
                problems.append(f"{test_id} ran in {where} run ({path.name}); serial files run alone, and only they do")
            elapsed = float(case.get("time", "0") or 0)
            shard_seconds += elapsed
            if key in by_key:
                file = test_id.split("::", 1)[0]
                seconds[file] = seconds.get(file, 0.0) + elapsed
            if case.find("failure") is not None:
                failed_here += 1
                problems.append(f"{test_id} failed ({path.name})")
            if case.find("error") is not None:
                errored_here += 1
                problems.append(f"{test_id} errored ({path.name})")
            if case.find("skipped") is not None:
                skipped_here += 1
                skipped.add(test_id)
                if test_id not in skips:
                    problems.append(f"{test_id} was skipped ({path.name}) and is not an expected skip")
        if shard.reported != len(shard.cases):
            problems.append(f"{path.name} reports {shard.reported} tests but lists {len(shard.cases)}")
        if shard.errors > errored_here or shard.failures > failed_here:
            problems.append(f"{path.name} reports errors or failures outside its test cases (collection?)")
        summary.append(
            f"| {path.name} | {len(shard.cases)} | {failed_here} | {errored_here} | {skipped_here} | {shard_seconds:.1f} |"
        )

    twice = sorted(by_key.get(key, f"{key[0]}::{key[1]}") for key, count in ran.items() if count > 1)
    if twice:
        problems.append(f"ran more than once: {twice}")
    missing = sorted(test_id for test_id, key in keys.items() if key not in ran)
    if missing:
        problems.append(f"{len(missing)} collected tests did not run: {missing}")
    extra = sorted(f"{key[0]}::{key[1]}" for key in ran if key not in by_key)
    if extra:
        problems.append(f"{len(extra)} tests ran that were not collected: {extra}")
    not_skipped = sorted(test_id for test_id in skips & set(ids) if test_id not in skipped and keys[test_id] in ran)
    if not_skipped:
        problems.append(f"expected skips that ran instead (update the list; the skip count must match): {not_skipped}")
    summary.append(f"| **total** | {sum(ran.values())} of {len(ids)} collected | | | | |")
    return problems, {file: round(value, 1) for file, value in sorted(seconds.items())}, summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--collected", type=Path, required=True)
    parser.add_argument("--junit-dir", type=Path, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--expected-skips", type=Path)
    parser.add_argument("--serial", type=Path, help="files that must have run alone (pytest_shards.py --serial)")
    parser.add_argument("--test-root", type=Path, help="every test file under it must have a collected test")
    parser.add_argument("--durations-out", type=Path)
    args = parser.parse_args(argv)

    junit_files = sorted(args.junit_dir.rglob("*.xml"))
    problems, seconds, summary = check(
        args.collected.read_text(),
        junit_files,
        args.shards,
        expected_skips(args.expected_skips),
        expected_skips(args.serial),
        test_files(args.test_root) if args.test_root else None,
    )
    durations = json.dumps(seconds, indent=2) + "\n"
    report = [*summary, "", "Seconds per file in this run (shard weights):", "```json", durations.rstrip(), "```"]
    print("\n".join(report))
    if args.durations_out:
        args.durations_out.write_text(durations)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write("\n".join(["### Todofy runtime shards", "", *report, ""]) + "\n")
    for problem in problems:
        print(f"::error::{problem}" if os.environ.get("GITHUB_ACTIONS") else f"ERROR: {problem}", file=sys.stderr)
    if problems:
        return 1
    total = len(collected_ids(args.collected.read_text())[0])
    print(f"OK: all {total} collected tests ran exactly once across {args.shards} shards and passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
