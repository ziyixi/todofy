#!/usr/bin/env python3
"""Decide which apps a CI run checks and deploys. Standard library only (the runner's python3).

Outputs (GITHUB_OUTPUT, "true"/"false"):
  todofy_check, mail_hero_check, dashboard_check, website_check, lab_check
                    run that app's full checks
  contracts         run the contract tests: both sides of mail.received.v1, ops-v1 and
                    task-intent-v1, and the dashboard's ops-v1 caller tests
  packages          run every shared package's own checks (packages/*)
  infra             run "Infra checks" (OpenTofu fmt/validate of infra/, its guards and the plan-summary
                    tests): infra/, tools/infra-plan-summary/ or .github/ changed. Never deploys anything;
                    not set by a dispatch (no app needs it).
  todofy_deploy, mail_hero_deploy, dashboard_deploy, website_deploy, lab_deploy
                    the app, a shared package it compiles in, or a contract file it bundles changed
                    (deploy jobs also require refs/heads/main)
  website_relay_deploy
                    website/relay/ (the Notion relay Worker, its own wrangler.toml) changed: deploy
                    the relay. A change only there checks the website but does not release the site;
                    a website change elsewhere releases the site but does not redeploy the relay.

push: the files changed between a cumulative base and github.sha, never only this push's own diff,
so a change whose run was cancelled or failed is checked (and deployed) again by the next run.
  main           base = the commit of the last successful push run of this workflow on main
                 (LAST_SUCCESS). Any run that failed or was cancelled, including a cancelled deploy,
                 is not "success", so its changes stay in the next run's diff.
  other branches base = git merge-base origin/main HEAD, so the head commit's gate covers every
                 change on the branch, not only the latest push.
  No usable base (no successful main run yet, API failure, base not an ancestor, no origin/main)
  runs everything. An app's own directory checks and deploys it; contracts/ and .github/ re-check
  every app but deploy none, except the contract files the TypeScript Workers bundle (BUNDLED_BY,
  e.g. OPS_LIMITS in contracts/ops-v1/ops-v1.ts, or the schema and validate.mjs the dashboard checks
  answers with), which also deploy every app listed for them. A
  shared package packages/<name>/ is compiled into the apps listed in PACKAGE_USERS, so any change
  inside it runs the package checks and checks AND deploys each of those apps. Its Markdown documents
  (packages/<name>/**/*.md: README, SPEC) are compiled into nothing: they run the package checks and
  check those apps (tests cite the SPEC) but deploy none, so a documentation edit never redeploys
  production. A package missing from PACKAGE_USERS counts as used by every app (fail safe; the tests
  run by the Changes job also fail until PACKAGE_USERS matches the file: dependencies). A file
  directly under packages/ (a README) is root documentation: gate only.
A push to main reuses a green branch run of the same commit (find_reusable): when a completed push run of
this workflow on another branch has the same head SHA, concluded success, and its Changes, CI gate and
every check job this push needs (CHECK_JOBS) succeeded, the check outputs are all false (those jobs are
skipped), checks_reused=true names that run, and the deploy outputs are unchanged. The deploy jobs accept
a skipped check job only together with checks_reused; the gate passes and prints the run. The same SHA is
the same tree and the same ci.yml, and no check job uses a secret, so the branch run's verdict holds.
Anything else (no such run, a check it did not run, an API error, workflow_dispatch) runs the checks.
tools/ (CI tooling such as the deploy hostname guard) counts as .github/: every app is re-checked, none
deployed. The exception is tools/infra-plan-summary/, which belongs to infra/: it runs only Infra checks,
as infra/ does (and .github/ does too); the other tools/ do not run them.
workflow_dispatch: the "app" input checks and deploys that app ("both" = Todofy and Mail Hero, as
before; "all" = every app; or one app; "website" = the site and its relay), and the contracts and
shared packages are checked too. The website uses no contract and no package, so a website-only
change does not run Contracts.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable

APPS = ("todofy", "mail-hero", "dashboard", "website", "lab")
# The output key prefix of each app ("<prefix>_check", "<prefix>_deploy").
PREFIX = {"todofy": "todofy", "mail-hero": "mail_hero", "dashboard": "dashboard", "website": "website", "lab": "lab"}
KEYS = (
    "todofy_check",
    "mail_hero_check",
    "dashboard_check",
    "website_check",
    "lab_check",
    "contracts",
    "packages",
    "infra",
    "todofy_deploy",
    "mail_hero_deploy",
    "dashboard_deploy",
    "website_deploy",
    "website_relay_deploy",
    "lab_deploy",
)
DISPATCH = {
    "both": ("todofy", "mail-hero"),
    "all": APPS,
    "todofy": ("todofy",),
    "mail-hero": ("mail-hero",),
    "dashboard": ("dashboard",),
    "website": ("website",),
    "lab": ("lab",),
}
# The website's Notion relay Worker deploys on its own (website_relay_deploy).
RELAY = "website/relay/"
# Apps that neither provide nor consume a contract: their own changes do not run Contracts.
NO_CONTRACTS = {"website"}
# The plan-only OpenTofu configuration (infra/README.md) and its plan-summary tool: checked, never applied.
INFRA = ("infra/", "tools/infra-plan-summary/")
# packages/<name>/ -> the apps whose Workers compile it in (a "file:../../packages/<name>" dependency).
PACKAGE_USERS = {"edge-auth": ("todofy", "mail-hero", "dashboard", "lab")}

# Contract files whose code a TypeScript Worker imports at runtime (constants such as OPS_LIMITS land
# in its bundle; the dashboard also validates every Ops answer with the schema and validate.mjs),
# mapped to the apps that bundle them: a change ships only with a deploy of each.
# test_ci_changes.py checks this map against the Workers' imports.
BUNDLED_BY = {
    "contracts/ops-v1/ops-v1.ts": ("todofy", "mail-hero", "dashboard", "lab"),
    # The dashboard validates every Ops answer; Lab validates setGuard input, its intents and Todofy's answers.
    "contracts/ops-v1/ops-v1.schema.json": ("dashboard", "lab"),
    "contracts/ops-v1/validate.mjs": ("dashboard", "lab"),
    # task-intent-v1: Lab proposes (bounds, schema), Todofy's gateway forwards (bounds, types).
    "contracts/task-intent-v1/task-intent-v1.ts": ("lab", "todofy"),
    "contracts/task-intent-v1/task-intent-v1.schema.json": ("lab",),
}

# Outputs that describe a reused branch run (strings, one line each).
REUSE_KEYS = ("checks_reused", "reused_run_url", "reused_jobs")
# The check outputs, and the jobs (by their names in ci.yml) that must have succeeded in a reused run when
# this push needs that output. "<name> (*)" stands for every job of a matrix ("Todofy runtime (1/3)", ...):
# at least one, and all of them. test_ci_changes.py checks these names against ci.yml.
CHECK_JOBS = {
    "todofy_check": ("Todofy static checks", "Todofy runtime (*)", "Todofy checks"),
    "mail_hero_check": ("Mail Hero checks",),
    "dashboard_check": ("Dashboard checks",),
    "website_check": ("Website checks",),
    "lab_check": ("Lab checks",),
    "contracts": ("Contracts",),
    "packages": ("Shared packages",),
    "infra": ("Infra checks",),
}
# Jobs every reused run must have passed, whatever this push needs.
ALWAYS_JOBS = ("Changes", "CI gate")
# How many same-SHA branch runs are inspected (newest first).
MAX_REUSE_CANDIDATES = 5


def everything() -> dict[str, bool]:
    return dict.fromkeys(KEYS, True)


def outputs(
    checked: Iterable[str],
    deployed: Iterable[str],
    contracts: bool,
    packages: bool,
    relay: bool = False,
    infra: bool = False,
) -> dict[str, bool]:
    checked, deployed = set(checked), set(deployed)
    result = {
        "contracts": contracts,
        "packages": packages,
        "infra": infra,
        "website_relay_deploy": relay,
    }
    for app in APPS:
        result[f"{PREFIX[app]}_check"] = app in checked
        result[f"{PREFIX[app]}_deploy"] = app in deployed
    return {key: result[key] for key in KEYS}


def is_package_document(path: str) -> bool:
    """A Markdown file inside a package (packages/<name>/**/*.md): documentation, never compiled in."""
    return path.startswith("packages/") and path.count("/") >= 2 and path.endswith(".md")


def classify(paths: Iterable[str]) -> dict[str, bool]:
    paths = [path for path in paths if path]
    apps = {app for app in APPS if any(path.startswith(f"{app}/") for path in paths)}
    # packages/<name>/<file>: at least three components; packages/README.md is documentation.
    package_paths = [path for path in paths if path.startswith("packages/") and path.count("/") >= 2]
    package_names = {path.split("/")[1] for path in package_paths}
    # Users of a package whose code (anything but its documents) changed are checked and deployed;
    # users of a package whose documents alone changed are only checked.
    compiled = {path.split("/")[1] for path in package_paths if not is_package_document(path)}
    documented: set[str] = set()
    for name in package_names:
        (apps if name in compiled else documented).update(PACKAGE_USERS.get(name, APPS))
    # tools/ is CI tooling (the deploy hostname guard tools/cf-guard): like .github/, it re-checks every app.
    # tools/infra-plan-summary/ belongs to infra/ and runs only Infra checks.
    ci = any(path.startswith((".github/", "tools/")) and not path.startswith(INFRA) for path in paths)
    shared = ci or any(path.startswith("contracts/") for path in paths)
    bundled = {app for path in paths for app in BUNDLED_BY.get(path, ())}
    # website/relay/ is its own Worker: it deploys itself, not the site (unless the site's own files, or a
    # package counted as used by it, changed too).
    relay = any(path.startswith(RELAY) for path in paths)
    site = any(path.startswith("website/") and not path.startswith(RELAY) for path in paths)
    site |= any("website" in PACKAGE_USERS.get(name, APPS) for name in compiled)
    deployed = apps | bundled
    if not site:
        deployed -= {"website"}
    return outputs(
        checked=APPS if shared else apps | documented,
        deployed=deployed,
        contracts=bool((apps - NO_CONTRACTS) | documented) or shared,
        packages=bool(package_names) or ci,
        relay=relay,
        infra=any(path.startswith((".github/", *INFRA)) for path in paths),
    )


def dispatched(app: str) -> dict[str, bool]:
    if app not in DISPATCH:
        raise ValueError(f"unknown app input {app!r}; expected one of {sorted(DISPATCH)}")
    apps = DISPATCH[app]
    website = "website" in apps
    return outputs(checked=apps, deployed=apps, contracts=True, packages=True, relay=website)


MAIN = "refs/heads/main"


def decide(
    event: str,
    ref: str,
    after: str,
    app: str,
    last_success: str,
    diff: Callable[[str, str], list[str]],
    is_ancestor: Callable[[str, str], bool],
    merge_base: Callable[[str], str],
) -> tuple[dict[str, bool], str]:
    if event == "workflow_dispatch":
        return dispatched(app or "both"), f"dispatched for {app or 'both'}"
    if event != "push":
        return everything(), f"event {event!r}: running everything"
    if ref == MAIN:
        if not last_success or set(last_success) == {"0"}:
            return everything(), "no successful push run of this workflow on main yet: running everything"
        if not is_ancestor(last_success, after):
            return everything(), f"last successful main run {last_success[:12]} is not an ancestor: running everything"
        base, why = last_success, "the last successful main run"
    else:
        base = merge_base(after)
        if not base:
            return everything(), "no merge base with origin/main: running everything"
        why = "the merge base with origin/main"
    paths = diff(base, after)
    return classify(paths), f"{len(paths)} file(s) changed since {base[:12]} ({why})"


def required_jobs(result: dict[str, bool]) -> list[str]:
    """The job names a reused run must have passed for this push's check outputs."""
    names = list(ALWAYS_JOBS)
    for key, jobs in CHECK_JOBS.items():
        if result[key]:
            names.extend(job for job in jobs if job not in names)
    return names


def jobs_cover(jobs: list[dict], names: Iterable[str]) -> bool:
    """Every named job (a matrix: every one of its jobs) is present and concluded success."""
    for name in names:
        if name.endswith(" (*)"):
            prefix = name[: -len("*)")]
            matches = [job for job in jobs if str(job.get("name", "")).startswith(prefix) and str(job.get("name", "")).endswith(")")]
        else:
            matches = [job for job in jobs if job.get("name") == name]
        if not matches or any(job.get("status") != "completed" or job.get("conclusion") != "success" for job in matches):
            return False
    return True


def find_reusable(
    get: Callable[[str], dict], repository: str, run_id: str, sha: str, result: dict[str, bool]
) -> tuple[dict | None, list[str], str]:
    """A green branch push run of this workflow for exactly this commit that ran every check this push
    needs: (run, required job names, reason). `get` reads a GitHub REST path and returns its JSON."""
    current = get(f"/repos/{repository}/actions/runs/{run_id}")
    workflow_id = current.get("workflow_id")
    if not isinstance(workflow_id, int):
        return None, [], "this run's workflow is unknown"
    query = urllib.parse.urlencode({"head_sha": sha, "event": "push", "status": "completed", "per_page": 100})
    listing = get(f"/repos/{repository}/actions/workflows/{workflow_id}/runs?{query}")
    candidates = [
        run
        for run in listing.get("workflow_runs", [])
        if isinstance(run, dict)
        and str(run.get("id")) != str(run_id)
        and run.get("workflow_id") == workflow_id
        and run.get("head_sha") == sha
        and run.get("event") == "push"
        and run.get("head_branch") not in (None, "", "main")
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and (run.get("repository") or {}).get("full_name") == repository
        and (run.get("head_repository") or {}).get("full_name") == repository
    ]
    candidates.sort(key=lambda run: int(run.get("id", 0)), reverse=True)
    names = required_jobs(result)
    for run in candidates[:MAX_REUSE_CANDIDATES]:
        jobs = get(f"/repos/{repository}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
        if int(jobs.get("total_count", 0)) > 100:
            continue
        if jobs_cover(jobs.get("jobs", []), names):
            return run, names, f"reusing the green branch run {run.get('html_url', run['id'])} of this commit"
    if not candidates:
        return None, names, "no green branch run of this commit"
    return None, names, "no green branch run of this commit ran every check this push needs"


def reuse(result: dict[str, bool], run: dict, names: list[str]) -> tuple[dict[str, bool], dict[str, str]]:
    """Skip every check (the reused run passed them); keep every deploy decision."""
    reused = {key: (False if key in CHECK_JOBS else value) for key, value in result.items()}
    extra = {"checks_reused": "true", "reused_run_url": str(run.get("html_url", "")), "reused_jobs": ", ".join(names)}
    return reused, extra


NO_REUSE = {"checks_reused": "false", "reused_run_url": "", "reused_jobs": ""}


def github_get(token: str, api_url: str) -> Callable[[str], dict]:
    def get(path: str) -> dict:
        request = urllib.request.Request(
            api_url.rstrip("/") + path,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    return get


def try_reuse(
    event: str, ref: str, sha: str, result: dict[str, bool], environ: dict[str, str], get: Callable[[str], dict] | None = None
) -> tuple[dict[str, bool], dict[str, str], str]:
    """Only a push to main that needs checks looks for a run to reuse; any failure runs the checks."""
    if event != "push" or ref != MAIN or not any(result[key] for key in CHECK_JOBS):
        return result, dict(NO_REUSE), ""
    repository, run_id = environ.get("GITHUB_REPOSITORY", ""), environ.get("GITHUB_RUN_ID", "")
    token = environ.get("GH_TOKEN", "")
    if get is None:
        if not (token and repository and run_id):
            return result, dict(NO_REUSE), "checks run: no token to look for a green branch run"
        get = github_get(token, environ.get("GITHUB_API_URL", "https://api.github.com"))
    try:
        run, names, why = find_reusable(get, repository, run_id, sha, result)
    except urllib.error.HTTPError as error:
        return result, dict(NO_REUSE), f"checks run: the run lookup failed with HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - any failure means: run the checks
        return result, dict(NO_REUSE), f"checks run: the run lookup failed ({type(error).__name__})"
    if run is None:
        return result, dict(NO_REUSE), f"checks run: {why}"
    reused, extra = reuse(result, run, names)
    return reused, extra, f"checks reused: {why} ({extra['reused_jobs']})"


def git_diff(base: str, after: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", base, after], check=True, capture_output=True, text=True
    )
    return result.stdout.splitlines()


def git_is_ancestor(base: str, after: str) -> bool:
    return (
        subprocess.run(["git", "merge-base", "--is-ancestor", base, after], capture_output=True, check=False).returncode
        == 0
    )


def git_merge_base(after: str) -> str:
    result = subprocess.run(["git", "merge-base", "origin/main", after], capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def main(get: Callable[[str], dict] | None = None) -> int:
    event, ref = os.environ.get("EVENT_NAME", ""), os.environ.get("REF", "")
    after = os.environ.get("AFTER", "HEAD")
    result, reason = decide(
        event,
        ref,
        after,
        os.environ.get("DISPATCH_APP", ""),
        os.environ.get("LAST_SUCCESS", "").strip(),
        git_diff,
        git_is_ancestor,
        git_merge_base,
    )
    result, extra, reuse_reason = try_reuse(event, ref, after, result, dict(os.environ), get)
    if reuse_reason:
        reason = f"{reason}; {reuse_reason}"
    lines = [f"{key}={str(result[key]).lower()}" for key in KEYS]
    lines += [f"{key}={' '.join(extra[key].split())}" for key in REUSE_KEYS]
    print(reason)
    print("\n".join(lines))
    for name, text in (("GITHUB_OUTPUT", "\n".join(lines)), ("GITHUB_STEP_SUMMARY", summary(result, reason))):
        if os.environ.get(name):
            with open(os.environ[name], "a", encoding="utf-8") as handle:
                handle.write(text + "\n")
    return 0


def summary(result: dict[str, bool], reason: str) -> str:
    rows = "\n".join(f"| `{key}` | {'yes' if result[key] else 'no'} |" for key in KEYS)
    return f"### Changed areas\n\n{reason}\n\n| Output | Runs |\n| --- | --- |\n{rows}"


if __name__ == "__main__":
    sys.exit(main())
