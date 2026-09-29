#!/usr/bin/env python3
"""Decide which apps a CI run checks and deploys. Standard library only (the runner's python3).

Outputs (GITHUB_OUTPUT, "true"/"false"):
  todofy_check, mail_hero_check  run that app's full checks
  contracts                      run both sides' mail.received.v1 contract tests
  todofy_deploy, mail_hero_deploy  the app itself changed (deploy jobs also require refs/heads/main)

push: the files changed between github.event.before and github.sha. An app's own directory
checks and deploys it; contracts/ and .github/ re-check both apps but deploy neither. A new
branch, a force push or any other unknown "before" runs everything.
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


def decide(
    event: str,
    before: str,
    after: str,
    app: str,
    diff: Callable[[str, str], list[str]],
    known: Callable[[str], bool],
) -> tuple[dict[str, bool], str]:
    if event == "workflow_dispatch":
        return dispatched(app or "both"), f"dispatched for {app or 'both'}"
    if event != "push":
        return everything(), f"event {event!r}: running everything"
    if not before or set(before) == {"0"}:
        return everything(), "no previous commit (new branch): running everything"
    if not known(before):
        return everything(), f"previous commit {before[:12]} is not in the history (force push?): running everything"
    paths = diff(before, after)
    return classify(paths), f"{len(paths)} file(s) changed since {before[:12]}"


def git_diff(before: str, after: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", before, after], check=True, capture_output=True, text=True
    )
    return result.stdout.splitlines()


def git_known(commit: str) -> bool:
    return subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], capture_output=True).returncode == 0


def main() -> int:
    result, reason = decide(
        os.environ.get("EVENT_NAME", ""),
        os.environ.get("BEFORE", ""),
        os.environ.get("AFTER", "HEAD"),
        os.environ.get("DISPATCH_APP", ""),
        git_diff,
        git_known,
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
