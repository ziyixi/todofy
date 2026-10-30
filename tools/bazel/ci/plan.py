"""Select affected leaves of public check facades and group compatible tests for CI."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

ROOTS_QUERY = 'visible(//:package.json, filter(":check$", //...))'
RELEASES_QUERY = 'visible(//:package.json, attr("tags", "release:", //...))'
RELEASE_KINDS = {"worker", "image", "extension", "website"}
GATE = "CI gate"
GROUPS = ("node", "python", "go", "browser", "workerd", "cpu", "container", "check")
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
        return "", "manual dispatch checks the complete check graph"
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
            else "no usable branch base; checking the complete check graph",
        )
    if not all(
        os.environ.get(key)
        for key in ("GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID")
    ):
        return "", "no main check evidence available; checking the complete check graph"
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
            f"main check lookup failed ({type(error).__name__}); checking the complete check graph",
        )
    return (
        base,
        "latest ancestor with a successful Bazel check gate"
        if base
        else "no green main check base; checking the complete check graph",
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
            (tag for tag in ("cpu", "browser", "workerd", "container") if tag in tags),
            None,
        )
        if group is None:
            group = {"py_test": "python", "go_test": "go", "js_test": "node"}.get(
                rule.attrib["class"], "check"
            )
        groups.setdefault(group, []).append(label)
    return {group: sorted(targets) for group, targets in sorted(groups.items())}


def leaf_query(roots: list[str], resume_vps_release: bool = False) -> str:
    leaves = "tests(set(" + " ".join(sorted(set(roots))) + "))"
    query = leaves + ' except attr("tags", "manual", ' + leaves + ")"
    if resume_vps_release:
        query += ' except attr("tags", "container", ' + leaves + ")"
    return query


def dispatch_releases(
    catalog: dict[str, dict[str, str]], app: str
) -> dict[str, dict[str, str]]:
    if not app:
        return catalog
    from releases import select

    chosen = {
        (item["kind"], item["app"]) for item in select(list(catalog.values()), [], app)
    }
    return {
        label: item
        for label, item in catalog.items()
        if (item["kind"], item["app"]) in chosen
    }


def dispatch_check_roots(
    roots: list[str],
    selected_releases: dict[str, dict[str, str]],
    app: str,
    resume_vps_release: bool = False,
) -> list[str]:
    if not app or app == "all":
        return roots
    packages = {item["target"].split(":")[0] for item in selected_releases.values()}
    if resume_vps_release and app == "codex-gateway":
        packages.add("//platform")
    missing = packages - {root.split(":")[0] for root in roots}
    if missing:
        raise ValueError(
            "Requested apps have no public :check facade: " + ", ".join(sorted(missing))
        )
    return [
        root
        for root in roots
        if root.split(":")[0] in packages
        or root.removeprefix("//").split("/", 1)[0].split(":", 1)[0]
        in {"proto", "packages", "tools", ".github", "infra"}
    ]


def check_scope(
    bazel: str,
    startup: list[str],
    app: str = "",
    resume_vps_release: bool = False,
    selected_releases: dict[str, dict[str, str]] | None = None,
) -> tuple[list[str], str, str]:
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
    roots = dispatch_check_roots(
        roots, selected_releases or {}, app, resume_vps_release
    )
    # Discover the leaf closure without configured analysis. The TD call receives
    # its literal candidates so excluded containers never enter cquery's universe.
    query = leaf_query(roots, resume_vps_release)
    xml = run([bazel, *startup, "query", query, "--output=xml", repository_cache])
    return roots, query, xml


def release_metadata(xml: str) -> dict[str, dict[str, str]]:
    releases = {}
    identities = set()
    for rule in ET.fromstring(xml).findall("rule"):
        label = rule.attrib["name"]
        tags = [
            item.attrib["value"] for item in rule.findall("./list[@name='tags']/string")
        ]
        release_tags = [tag for tag in tags if tag.startswith("release:")]
        artifacts = [
            tag.removeprefix("artifact:") for tag in tags if tag.startswith("artifact:")
        ]
        if (
            rule.attrib["class"] != "filegroup"
            or len(release_tags) != 1
            or len(artifacts) != 1
        ):
            raise ValueError(
                f"{label}: release facade needs one release tag and one artifact tag on a filegroup"
            )
        parts = release_tags[0].split(":")
        if (
            len(parts) != 3
            or parts[1] not in RELEASE_KINDS
            or not re.fullmatch(r"[a-z][a-z0-9-]*", parts[2])
        ):
            raise ValueError(f"{label}: invalid release kind or app identifier")
        owner = re.fullmatch(r"//([a-z][a-z0-9-]*):[^/:]+", label)
        artifact = re.fullmatch(r"//([a-z][a-z0-9-]*):[A-Za-z0-9_.+-]+", artifacts[0])
        if owner is None or artifact is None or owner[1] != artifact[1]:
            raise ValueError(
                f"{label}: artifact must be a target in the same app root package"
            )
        identity = (parts[1], parts[2])
        if identity in identities:
            raise ValueError(f"{label}: duplicate release kind/app identity")
        identities.add(identity)
        releases[label] = {"app": parts[2], "kind": parts[1], "target": artifacts[0]}
    return releases


def release_scope(
    bazel: str, startup: list[str], query: str
) -> dict[str, dict[str, str]]:
    xml = run(
        [
            bazel,
            *startup,
            "query",
            query,
            "--output=xml",
            "--repository_cache="
            + str(Path.home() / ".cache/personal-cloud-bazel/repository"),
        ]
    )
    return release_metadata(xml)


def selection_query(tests: str, releases: dict[str, dict[str, str]]) -> str:
    if not releases:
        return tests
    return "(" + tests + ") union set(" + " ".join(sorted(releases)) + ")"


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
        return candidates, "base has no MODULE.bazel; all current checks"
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
        "--app",
        default="",
        help="Dispatch all, both (Todofy/Mail Hero), or one release app",
    )
    parser.add_argument(
        "--resume-vps-release",
        action="store_true",
        help="Check source without building images for an explicit VPS continuation",
    )
    parser.add_argument(
        "--base", help="Use an explicit already-resolved baseline for local validation"
    )
    parser.add_argument(
        "--release-input-query",
        nargs="?",
        const=RELEASES_QUERY,
        help="Include tagged public release facades in the same TD comparison; requires an explicit cumulative --base",
    )
    args = parser.parse_args()
    if args.release_input_query is not None and args.base is None:
        parser.error("release comparison requires an explicit cumulative --base")
    if args.app and args.release_input_query is None:
        parser.error("--app requires the release catalog from --release-input-query")
    if args.resume_vps_release and args.app not in {
        "newsletter",
        "platform",
        "codex-gateway",
    }:
        parser.error("--resume-vps-release requires one VPS application")
    base, reason = (
        (args.base, "explicit baseline") if args.base is not None else baseline()
    )
    catalog = (
        release_scope(args.bazel, args.bazel_startup_option, args.release_input_query)
        if args.release_input_query is not None
        else {}
    )
    releases = dispatch_releases(catalog, args.app)
    roots, query, xml = check_scope(
        args.bazel,
        args.bazel_startup_option,
        args.app,
        args.resume_vps_release,
        releases,
    )
    candidates = {rule.attrib["name"] for rule in ET.fromstring(xml).findall("rule")}
    if args.resume_vps_release:
        releases = {
            label: item for label, item in releases.items() if item["kind"] != "image"
        }
    # Resolve the test closure before configured analysis: even an excluded test suite member
    # can otherwise pull its image dependencies into cquery's target universe.
    query = selection_query("set(" + " ".join(sorted(candidates)) + ")", releases)
    selected, selector = affected_targets(
        base,
        args.bazel,
        args.determinator,
        args.bazel_startup_option,
        candidates | releases.keys(),
        query,
    )
    groups = target_groups(xml, selected)
    plan = {
        "base": base,
        "reason": reason,
        "selector": selector,
        "check_roots": roots,
        "groups": groups,
        "release_catalog": [catalog[label] for label in sorted(catalog)],
        "releases": [
            releases[label] for label in sorted(releases) if label in selected
        ],
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
