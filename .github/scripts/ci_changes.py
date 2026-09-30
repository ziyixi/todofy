#!/usr/bin/env python3
"""Decide which apps a CI run checks and deploys. Standard library only (the runner's python3).

Outputs (GITHUB_OUTPUT, "true"/"false"):
  todofy_check, mail_hero_check, dashboard_check
                    run that app's full checks
  contracts         run the contract tests: both sides of mail.received.v1 and ops-v1, and the
                    dashboard's ops-v1 caller tests
  packages          run every shared package's own checks (packages/*)
  todofy_deploy, mail_hero_deploy, dashboard_deploy
                    the app, a shared package it compiles in, or a contract file it bundles changed
                    (deploy jobs also require refs/heads/main)

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
  inside it runs the package checks and checks AND deploys each of those apps. A package missing
  from PACKAGE_USERS counts as used by every app (fail safe; the tests run by the Changes job also
  fail until PACKAGE_USERS matches the file: dependencies). A file directly under packages/ (a
  README) is root documentation: gate only.
workflow_dispatch: the "app" input checks and deploys that app ("both" = Todofy and Mail Hero, as
before; "all" = every app; or one app), and the contracts and shared packages are checked too.
"""

import os
import subprocess
import sys
from collections.abc import Callable, Iterable

APPS = ("todofy", "mail-hero", "dashboard")
# The output key prefix of each app ("<prefix>_check", "<prefix>_deploy").
PREFIX = {"todofy": "todofy", "mail-hero": "mail_hero", "dashboard": "dashboard"}
KEYS = (
    "todofy_check",
    "mail_hero_check",
    "dashboard_check",
    "contracts",
    "packages",
    "todofy_deploy",
    "mail_hero_deploy",
    "dashboard_deploy",
)
DISPATCH = {
    "both": ("todofy", "mail-hero"),
    "all": APPS,
    "todofy": ("todofy",),
    "mail-hero": ("mail-hero",),
    "dashboard": ("dashboard",),
}
# packages/<name>/ -> the apps whose Workers compile it in (a "file:../../packages/<name>" dependency).
PACKAGE_USERS = {"edge-auth": ("todofy", "mail-hero", "dashboard")}

# Contract files whose code a TypeScript Worker imports at runtime (constants such as OPS_LIMITS land
# in its bundle; the dashboard also validates every Ops answer with the schema and validate.mjs),
# mapped to the apps that bundle them: a change ships only with a deploy of each.
# test_ci_changes.py checks this map against the Workers' imports.
BUNDLED_BY = {
    "contracts/ops-v1/ops-v1.ts": ("todofy", "mail-hero", "dashboard"),
    "contracts/ops-v1/ops-v1.schema.json": ("dashboard",),
    "contracts/ops-v1/validate.mjs": ("dashboard",),
}


def everything() -> dict[str, bool]:
    return dict.fromkeys(KEYS, True)


def outputs(checked: Iterable[str], deployed: Iterable[str], contracts: bool, packages: bool) -> dict[str, bool]:
    checked, deployed = set(checked), set(deployed)
    result = {"contracts": contracts, "packages": packages}
    for app in APPS:
        result[f"{PREFIX[app]}_check"] = app in checked
        result[f"{PREFIX[app]}_deploy"] = app in deployed
    return {key: result[key] for key in KEYS}


def classify(paths: Iterable[str]) -> dict[str, bool]:
    paths = [path for path in paths if path]
    apps = {app for app in APPS if any(path.startswith(f"{app}/") for path in paths)}
    # packages/<name>/<file>: at least three components; packages/README.md is documentation.
    package_names = {path.split("/")[1] for path in paths if path.startswith("packages/") and path.count("/") >= 2}
    for name in package_names:
        apps.update(PACKAGE_USERS.get(name, APPS))
    ci = any(path.startswith(".github/") for path in paths)
    shared = ci or any(path.startswith("contracts/") for path in paths)
    bundled = {app for path in paths for app in BUNDLED_BY.get(path, ())}
    return outputs(
        checked=APPS if shared else apps,
        deployed=apps | bundled,
        contracts=bool(apps) or shared,
        packages=bool(package_names) or ci,
    )


def dispatched(app: str) -> dict[str, bool]:
    if app not in DISPATCH:
        raise ValueError(f"unknown app input {app!r}; expected one of {sorted(DISPATCH)}")
    apps = DISPATCH[app]
    return outputs(checked=apps, deployed=apps, contracts=True, packages=True)


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


def main() -> int:
    result, reason = decide(
        os.environ.get("EVENT_NAME", ""),
        os.environ.get("REF", ""),
        os.environ.get("AFTER", "HEAD"),
        os.environ.get("DISPATCH_APP", ""),
        os.environ.get("LAST_SUCCESS", "").strip(),
        git_diff,
        git_is_ancestor,
        git_merge_base,
    )
    lines = [f"{key}={str(result[key]).lower()}" for key in KEYS]
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
