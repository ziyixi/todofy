"""Turn affected Bazel release targets into the existing Actions publication decisions."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import urllib.parse
from collections.abc import Callable
from pathlib import Path

from plan import github_get

Release = dict[str, str]


def select(
    catalog: list[Release], affected: list[Release], requested: str = ""
) -> list[Release]:
    """Keep independent releases; Newsletter and Platform still roll out together."""
    if requested:
        names = {item["app"] for item in catalog}
        if requested == "both":
            names = {"todofy", "mail-hero"}
        elif requested != "all":
            if requested not in names:
                raise ValueError("The requested application has no release target")
            names = {requested}
            if requested == "website":
                names.add("website-relay")
        affected = [item for item in catalog if item["app"] in names]
    selected = {(item["kind"], item["app"]): item for item in affected}
    if any(key in selected for key in (("image", "newsletter"), ("image", "platform"))):
        for app in ("newsletter", "platform"):
            selected[("image", app)] = next(
                item
                for item in catalog
                if item["kind"] == "image" and item["app"] == app
            )
    return [selected[key] for key in sorted(selected)]


def job_name(release: Release) -> str:
    return f"Build artifact ({release['kind']}, {release['app']})"


def artifact_name(release: Release, sha: str) -> str:
    if release["kind"] == "image":
        return f"{release['app']}-image-{sha}"
    if release["kind"] == "extension":
        return f"recall-extensions-{sha}"
    return f"worker-{release['app']}-{sha}"


def reusable_artifacts(
    repository: str,
    run_id: str,
    sha: str,
    artifacts: list[Release],
    get: Callable[[str], dict],
) -> dict:
    """Reuse only a green branch run of this workflow and this exact source revision."""
    if not artifacts:
        return {}
    workflow = get(f"/repos/{repository}/actions/runs/{run_id}")["workflow_id"]
    query = urllib.parse.urlencode({"head_sha": sha, "event": "push", "per_page": 50})
    runs = get(f"/repos/{repository}/actions/workflows/{workflow}/runs?{query}")[
        "workflow_runs"
    ]
    required = {"CI gate", *(job_name(item) for item in artifacts)}
    candidates = [
        run
        for run in runs
        if str(run["id"]) != run_id
        and run["head_sha"] == sha
        and run["head_branch"] != "main"
        and run["event"] == "push"
        and run["workflow_id"] == workflow
        and run["conclusion"] == "success"
    ]
    for run in candidates[:5]:
        jobs = get(
            f"/repos/{repository}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100"
        )["jobs"]
        passed = {
            job["name"]
            for job in jobs
            if job["status"] == "completed" and job["conclusion"] == "success"
        }
        if required <= passed:
            listing = get(
                f"/repos/{repository}/actions/runs/{run['id']}/artifacts?per_page=100"
            )["artifacts"]
            available = {item["name"] for item in listing if not item["expired"]}
            if {artifact_name(item, sha) for item in artifacts} <= available:
                return {"id": str(run["id"]), "url": run["html_url"]}
    return {}


def successful_main_base(
    commits: list[str], repository: str, run_id: str, get: Callable[[str], dict]
) -> str:
    """A failed publication stays in the cumulative release diff on the next push."""
    workflow = get(f"/repos/{repository}/actions/runs/{run_id}")["workflow_id"]
    successful = set()
    for page in range(1, 4):
        query = urllib.parse.urlencode(
            {
                "branch": "main",
                "event": "push",
                "status": "success",
                "per_page": 100,
                "page": page,
            }
        )
        runs = get(f"/repos/{repository}/actions/workflows/{workflow}/runs?{query}")[
            "workflow_runs"
        ]
        successful.update(
            run["head_sha"]
            for run in runs
            if run["workflow_id"] == workflow
            and run["head_branch"] == "main"
            and run["event"] == "push"
            and run["conclusion"] == "success"
            and str(run["id"]) != run_id
        )
        if len(runs) < 100:
            break
    return next((commit for commit in commits if commit in successful), "")


def baseline(env: dict[str, str], get: Callable[[str], dict] = github_get) -> str:
    if env.get("GITHUB_EVENT_NAME") == "workflow_dispatch":
        return ""
    head = env["GITHUB_SHA"]
    if env.get("GITHUB_REF") != "refs/heads/main":
        result = subprocess.run(
            ["git", "merge-base", "origin/main", head],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    commits = subprocess.check_output(
        ["git", "rev-list", "--date-order", "--max-count=150", head + "^@"], text=True
    ).splitlines()
    return successful_main_base(
        commits, env["GITHUB_REPOSITORY"], env["GITHUB_RUN_ID"], get
    )


def outputs(
    catalog: list[Release], selected: list[Release], reused: dict, *, resume: str = ""
) -> dict[str, str]:
    values = {
        item["app"].replace("-", "_") + "_deploy": "false"
        for item in catalog
        if item["kind"] != "extension"
    }
    values["recall_extension_publish"] = "false"
    for item in selected:
        key = (
            "recall_extension_publish"
            if item["kind"] == "extension"
            else item["app"].replace("-", "_") + "_deploy"
        )
        values[key] = "true"
    values["platform_publish"] = values.get("platform_deploy", "false")
    artifacts = [item for item in selected if item["kind"] != "website"]
    if resume:
        if resume not in {"newsletter", "platform", "codex-gateway"}:
            raise ValueError("Only an existing VPS release can be resumed")
        values = {key: "false" for key in values}
        values[
            "codex_gateway_deploy" if resume == "codex-gateway" else "platform_deploy"
        ] = "true"
        artifacts = []
    values.update(
        {
            "artifact_run_id": reused.get("id", ""),
            "artifact_run_url": reused.get("url", ""),
            "artifacts_reused": str(bool(reused)).lower(),
            "has_artifacts": str(bool(artifacts) and not reused).lower(),
            "artifact_matrix": json.dumps(
                {"include": artifacts}, separators=(",", ":")
            ),
        }
    )
    return values


def write_outputs(values: dict[str, str]) -> None:
    lines = "\n".join(key + "=" + value for key, value in values.items()) + "\n"
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(lines)
    print(lines, end="")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("baseline", "select"))
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--app", default="")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--resume-sha", default="")
    args = parser.parse_args()
    if args.command == "baseline":
        base = baseline(dict(os.environ))
        changed = (
            not base
            or subprocess.run(
                [
                    "git",
                    "diff",
                    "--quiet",
                    base,
                    os.environ["GITHUB_SHA"],
                    "--",
                    "proto",
                ],
                check=False,
            ).returncode
            != 0
        )
        write_outputs({"base": base, "proto_breaking": str(changed).lower()})
    else:
        if args.plan is None:
            parser.error("--plan is required for release selection")
        if args.resume and (
            os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or not re.fullmatch(r"[0-9a-f]{40}", args.resume_sha)
        ):
            parser.error(
                "Resume requires a main dispatch and the held release's full source SHA"
            )
        if args.resume_sha and not args.resume:
            parser.error("--resume-sha only applies to an explicit resume")
        plan = json.loads(args.plan.read_text())
        selected = select(plan["release_catalog"], plan["releases"], args.app)
        reused = {}
        if (
            os.environ.get("GITHUB_EVENT_NAME") == "push"
            and os.environ.get("GITHUB_REF") == "refs/heads/main"
        ):
            reused = reusable_artifacts(
                os.environ["GITHUB_REPOSITORY"],
                os.environ["GITHUB_RUN_ID"],
                os.environ["GITHUB_SHA"],
                [item for item in selected if item["kind"] != "website"],
                github_get,
            )
        write_outputs(
            outputs(
                plan["release_catalog"],
                selected,
                reused,
                resume=args.app if args.resume else "",
            )
        )
