#!/usr/bin/env python3
"""Decide which apps a CI run checks and deploys. Standard library only (the runner's python3).

Outputs (GITHUB_OUTPUT, "true"/"false"):
  todofy_check, mail_hero_check  run that app's full checks
  contracts                      run both sides' mail.received.v1 contract tests
  todofy_deploy, mail_hero_deploy  the app itself changed (deploy jobs also require refs/heads/main)

push: the files changed between a cumulative base and github.sha, never only this push's own diff,
so a change whose run was cancelled or failed is checked (and deployed) again by the next run.
  main           base = the commit of the last successful push run of this workflow on main
                 (LAST_SUCCESS). Any run that failed or was cancelled, including a cancelled deploy,
                 is not "success", so its changes stay in the next run's diff.
  other branches base = git merge-base origin/main HEAD, so the head commit's gate covers every
                 change on the branch, not only the latest push.
  No usable base (no successful main run yet, API failure, base not an ancestor, no origin/main)
  runs everything. An app's own directory checks and deploys it; contracts/ and .github/ re-check
  both apps but deploy neither.
workflow_dispatch: the "app" input (both, todofy or mail-hero) checks and deploys that app.
"""

import os
import subprocess
import sys
from collections.abc import Callable, Iterable

KEYS = ("todofy_check", "mail_hero_check", "contracts", "todofy_deploy", "mail_hero_deploy")
DISPATCH = {"both": ("todofy", "mail-hero"), "todofy": ("todofy",), "mail-hero": ("mail-hero",)}


def everything() -> dict[str, bool]:
    return dict.fromkeys(KEYS, True)


def classify(paths: Iterable[str]) -> dict[str, bool]:
    paths = [path for path in paths if path]
    todofy = any(path.startswith("todofy/") for path in paths)
    mail_hero = any(path.startswith("mail-hero/") for path in paths)
    shared = any(path.startswith(("contracts/", ".github/")) for path in paths)
    return {
        "todofy_check": todofy or shared,
        "mail_hero_check": mail_hero or shared,
        "contracts": todofy or mail_hero or shared,
        "todofy_deploy": todofy,
        "mail_hero_deploy": mail_hero,
    }


def dispatched(app: str) -> dict[str, bool]:
    if app not in DISPATCH:
        raise ValueError(f"unknown app input {app!r}; expected one of {sorted(DISPATCH)}")
    apps = DISPATCH[app]
    todofy, mail_hero = "todofy" in apps, "mail-hero" in apps
    return {
        "todofy_check": todofy,
        "mail_hero_check": mail_hero,
        "contracts": True,
        "todofy_deploy": todofy,
        "mail_hero_deploy": mail_hero,
    }


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
