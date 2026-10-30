"""Select affected leaves of public check facades and group compatible tests for CI."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

ROOTS_QUERY = 'visible(//:package.json, filter(":check$", //...))'
GATE = "Bazel migration gate"
GROUPS = ("node", "python", "go", "browser", "workerd", "cpu", "check")
TD_VERSION = "target-determinator v0.34.0"


def run(command: list[str]) -> str:
    return subprocess.check_output(command, text=True).strip()


def github_get(path: str) -> dict:
    request = urllib.request.Request(
        os.environ.get("GITHUB_API_URL", "https://api.github.com") + path,
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def last_checked_main(
    commits: list[str], repository: str, run_id: str, get: Callable[[str], dict]
) -> str:
    """Choose by Git ancestry order and successful check evidence, independent of release outcomes."""
    workflow = get(f"/repos/{repository}/actions/runs/{run_id}").get("workflow_id")
    if not isinstance(workflow, int):
        return ""
    runs: dict[str, list[dict]] = {}
    for page in range(1, 4):
        query = urllib.parse.urlencode(
            {"branch": "main", "event": "push", "per_page": 100, "page": page}
        )
        listing = get(f"/repos/{repository}/actions/workflows/{workflow}/runs?{query}")
        batch = listing.get("workflow_runs", [])
        for candidate in batch:
            if (
                candidate.get("workflow_id") == workflow
                and candidate.get("head_branch") == "main"
                and candidate.get("event") == "push"
            ):
                runs.setdefault(candidate.get("head_sha", ""), []).append(candidate)
        if len(batch) < 100:
            break
    for commit in commits:
        for candidate in runs.get(commit, []):
            if str(candidate.get("id")) == run_id:
                continue
            jobs = get(
                f"/repos/{repository}/actions/runs/{candidate['id']}/jobs?filter=latest&per_page=100"
            )
            if any(
                job.get("name") == GATE
                and job.get("status") == "completed"
                and job.get("conclusion") == "success"
                for job in jobs.get("jobs", [])
            ):
                return commit
    return ""


def baseline() -> tuple[str, str]:
    if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        return "", "manual dispatch checks the complete foundation"
    head = os.environ.get("GITHUB_SHA") or run(["git", "rev-parse", "HEAD"])
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        result = subprocess.run(
            ["git", "merge-base", "origin/main", head],
            capture_output=True,
            text=True,
            check=False,
        )
        return (
            result.stdout.strip(),
            "branch merge base with origin/main"
            if result.returncode == 0
            else "no usable branch base; checking the complete foundation",
        )
    if not all(
        os.environ.get(key)
        for key in ("GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID")
    ):
        return "", "no main check evidence available; checking the complete foundation"
    commits = run(
        ["git", "rev-list", "--date-order", "--max-count=150", head + "^@"]
    ).splitlines()
    try:
        base = last_checked_main(
            commits,
            os.environ["GITHUB_REPOSITORY"],
            os.environ["GITHUB_RUN_ID"],
            github_get,
        )
    except (OSError, ValueError) as error:
        return (
            "",
            f"main check lookup failed ({type(error).__name__}); checking the complete foundation",
        )
    return (
        base,
        "latest ancestor with a successful Bazel check gate"
        if base
        else "no green main check base; checking the complete foundation",
    )


def target_groups(xml: str, selected: set[str]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for rule in ET.fromstring(xml).findall("rule"):
        label = rule.attrib["name"]
        if label not in selected:
            continue
        tags = {
            item.attrib["value"] for item in rule.findall("./list[@name='tags']/string")
        }
        if "manual" in tags:
            continue
        group = next(
            (tag for tag in ("cpu", "browser", "workerd") if tag in tags), None
        )
        if group is None:
            group = {"py_test": "python", "go_test": "go", "js_test": "node"}.get(
                rule.attrib["class"], "check"
            )
        groups.setdefault(group, []).append(label)
    return {group: sorted(targets) for group, targets in sorted(groups.items())}


def leaf_query(roots: list[str]) -> str:
    leaves = "tests(set(" + " ".join(sorted(set(roots))) + "))"
    return leaves + ' except attr("tags", "manual", ' + leaves + ")"


def check_scope(bazel: str, startup: list[str]) -> tuple[list[str], str, str]:
    repository_cache = "--repository_cache=" + str(
        Path.home() / ".cache/personal-cloud-bazel/repository"
    )
    roots = sorted(
        set(
            run(
                [
                    bazel,
                    *startup,
                    "query",
                    ROOTS_QUERY,
                    "--output=label",
                    repository_cache,
                ]
            ).splitlines()
        )
    )
    if not roots:
        raise RuntimeError("No public :check facades were found")
    # visible() is an unconfigured query operation. Target Determinator's cquery
    # receives the concrete public roots and computes the affected leaf tests.
    query = leaf_query(roots)
    xml = run([bazel, *startup, "query", query, "--output=xml", repository_cache])
    return roots, query, xml


def affected_targets(
    base: str,
    bazel: str,
    determinator: str,
    startup: list[str],
    candidates: set[str],
    query: str,
) -> tuple[set[str], str]:
    if not base:
        return candidates, "all"
    exists = subprocess.run(
        ["git", "cat-file", "-e", base + ":MODULE.bazel"],
        capture_output=True,
        check=False,
    )
    if exists.returncode:
        return candidates, "base has no MODULE.bazel; all current foundation checks"
    if run([determinator, "--version"]) != TD_VERSION:
        raise RuntimeError("Target Determinator must be v0.34.0")
    executable = shutil.which(bazel)
    if executable is None:
        raise RuntimeError("The Bazel executable is unavailable")
    repository_cache = str(Path.home() / ".cache/personal-cloud-bazel/repository")
    command = [
        determinator,
        "--bazel=" + executable,
        "--targets=" + query,
        "--nocache_results",
        "--before-query-error-behavior=ignore-and-build-all",
        "--bazel-opts=--repository_cache=" + repository_cache,
    ]
    command += ["--bazel-startup-opts=" + option for option in startup]
    selected = run(command + [base]).splitlines()
    return candidates.intersection(selected), "Target Determinator v0.34.0"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", default="bazel")
    parser.add_argument("--determinator", default="target-determinator")
    parser.add_argument("--bazel-startup-option", action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--base", help="Use an explicit already-resolved baseline for local validation"
    )
    args = parser.parse_args()
    base, reason = (
        (args.base, "explicit baseline") if args.base is not None else baseline()
    )
    roots, query, xml = check_scope(args.bazel, args.bazel_startup_option)
    candidates = {rule.attrib["name"] for rule in ET.fromstring(xml).findall("rule")}
    selected, selector = affected_targets(
        base,
        args.bazel,
        args.determinator,
        args.bazel_startup_option,
        candidates,
        query,
    )
    groups = target_groups(xml, selected)
    plan = {
        "base": base,
        "reason": reason,
        "selector": selector,
        "check_roots": roots,
        "groups": groups,
    }
    args.output.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    matrix = {"include": [{"group": group} for group in groups]}
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as handle:
            handle.write("matrix=" + json.dumps(matrix, separators=(",", ":")) + "\n")
            handle.write("has_work=" + str(bool(groups)).lower() + "\n")
            handle.write("base=" + base + "\n")
    print(
        f"{reason}; {selector}: {sum(map(len, groups.values()))} targets in {len(groups)} groups"
    )


if __name__ == "__main__":
    main()
