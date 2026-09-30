#!/usr/bin/env python3
"""The values of Todofy's two Workers that are never committed, added at deploy time.

The committed production configs are wrangler.toml (todofy-core) and gateway/wrangler.toml (the gateway
`todofy`). What they must not hold is added here:

- `--var NAME:value` (a plain_text var, exactly like a [vars] entry): BUILD_SHA (the commit) and the
  operational switches (GitHub environment variables; a release restates them and never overwrites them)
  on both Workers, and the core's TODOIST_DEFAULT_PROJECT_ID (a GitHub environment secret: pywrangler
  echoes its command line, and Actions masks secrets in every log line). The core's optional Todoist
  projects TODOIST_OPS_PROJECT_ID and TODOIST_REVIEW_PROJECT_ID (GitHub environment secrets too) are
  sent only when set: an empty or unset one adds no --var, so the Worker sees it unset and uses the
  default project.
- `--secrets-file` for the gateway: the owner's Access emails (GitHub environment secrets), which become
  Worker secrets shown as hidden.

Wrangler silently DELETES a var that a deploy does not send (no config has keep_vars), so this wrapper
refuses to run unless every value is present and valid. Messages name the setting, never a value.

    uv run python deploy/deploy_vars.py check
    uv run python deploy/deploy_vars.py secrets "$RUNNER_TEMP/todofy-gateway-secrets.json"
    uv run python deploy/deploy_vars.py exec core -- uv run pywrangler deploy [--dry-run] --config wrangler.toml
    uv run python deploy/deploy_vars.py exec gateway -- npx --no-install wrangler deploy [--dry-run] \\
        --config gateway/wrangler.toml --secrets-file "$RUNNER_TEMP/todofy-gateway-secrets.json"
"""

# .github/scripts/test_wrangler_configs.py reads these lines (a mode may take several): every CI step that
# runs `exec core`, `exec gateway` or `secrets` must set each input of that mode (Actions sets GITHUB_*).
# deploy-vars-inputs core: GITHUB_SHA TODOFY_MAINTENANCE_MODE TODOFY_TODOIST_DEFAULT_PROJECT_ID
# deploy-vars-inputs core: TODOFY_REMINDER_ENABLED TODOFY_PROCESSING_PAUSED TODOFY_FORCE_PAUSE_TODOIST
# deploy-vars-inputs core: TODOFY_GTD_REVIEW_ENABLED TODOFY_TODOIST_OPS_PROJECT_ID TODOFY_TODOIST_REVIEW_PROJECT_ID
# deploy-vars-inputs gateway: GITHUB_SHA TODOFY_MAINTENANCE_MODE
# deploy-vars-inputs secrets: TODOFY_ACCESS_OWNER TODOFY_ACCESS_OWNER_ALIASES

import json
import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIGS = {"core": ROOT / "wrangler.toml", "gateway": ROOT / "gateway" / "wrangler.toml"}

# Printable ASCII only, as packages/edge-auth requires of the owner and aliases (SPEC.md #36).
EMAIL = re.compile(r"(?=[\x21-\x7e]+\Z)[^\s@]+@[^\s@]+\.[^\s@]+")
FLAG = re.compile(r"true|false")
SHA = re.compile(r"[0-9a-f]{40}")
PROJECT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_ALIASES = 8  # the gateway's Access check refuses more aliases, or more than MAX_LIST_CHARS of them
MAX_LIST_CHARS = 2048


class SettingError(ValueError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Invalid or missing deploy setting: {name}")
        self.setting = name


@dataclass(frozen=True)
class Injected:
    name: str  # the Worker var
    source: str  # the environment variable CI sets
    kind: str  # "build", "toggle", "personal" or "optional" (a personal value that may be unset)
    pattern: re.Pattern[str]


def _shared() -> tuple[Injected, ...]:
    return (
        Injected("BUILD_SHA", "GITHUB_SHA", "build", SHA),
        # One value on both Workers: every deploy states it, and both deploys read the same variable.
        Injected("MAINTENANCE_MODE", "TODOFY_MAINTENANCE_MODE", "toggle", FLAG),
    )


INJECTED: dict[str, tuple[Injected, ...]] = {
    "core": (
        *_shared(),
        Injected("TODOIST_DEFAULT_PROJECT_ID", "TODOFY_TODOIST_DEFAULT_PROJECT_ID", "personal", PROJECT_ID),
        Injected("REMINDER_ENABLED", "TODOFY_REMINDER_ENABLED", "toggle", FLAG),
        Injected("PROCESSING_PAUSED", "TODOFY_PROCESSING_PAUSED", "toggle", FLAG),
        Injected("FORCE_PAUSE_TODOIST", "TODOFY_FORCE_PAUSE_TODOIST", "toggle", FLAG),
        Injected("GTD_REVIEW_ENABLED", "TODOFY_GTD_REVIEW_ENABLED", "toggle", FLAG),
        # docs/gtd-features.md §10: the [Todofy System] reminder's and the Sunday review's projects.
        Injected("TODOIST_OPS_PROJECT_ID", "TODOFY_TODOIST_OPS_PROJECT_ID", "optional", PROJECT_ID),
        Injected("TODOIST_REVIEW_PROJECT_ID", "TODOFY_TODOIST_REVIEW_PROJECT_ID", "optional", PROJECT_ID),
    ),
    "gateway": _shared(),
}
SECRET_INPUTS = ("TODOFY_ACCESS_OWNER", "TODOFY_ACCESS_OWNER_ALIASES")


def _required(env: Mapping[str, str], name: str, pattern: re.Pattern[str]) -> str:
    # GitHub passes an unset variable as "": no switch or identity has a default, so empty is missing too.
    value = env.get(name)
    if not value or not pattern.fullmatch(value):
        raise SettingError(name)
    return value


def _optional(env: Mapping[str, str], name: str, pattern: re.Pattern[str]) -> str:
    """An optional value: absent or empty means unset; anything else must be valid."""
    value = env.get(name) or ""
    if value and not pattern.fullmatch(value):
        raise SettingError(name)
    return value


def injected_vars(worker: str, env: Mapping[str, str]) -> dict[str, str]:
    """{NAME: value} for every var `worker` ("core" or "gateway") gets at deploy; an optional var that
    is unset is left out, so the deploy leaves it unset on the Worker."""
    values = {}
    for item in INJECTED[worker]:
        if item.kind == "optional":
            if value := _optional(env, item.source, item.pattern):
                values[item.name] = value
        else:
            values[item.name] = _required(env, item.source, item.pattern)
    return values


def wrangler_args(worker: str, env: Mapping[str, str]) -> list[str]:
    """The flags appended to the deploy command (wrangler splits --var at the first colon)."""
    return [flag for name, value in injected_vars(worker, env).items() for flag in ("--var", f"{name}:{value}")]


def generate_secrets(env: Mapping[str, str]) -> dict[str, str]:
    """Gateway secrets for `wrangler deploy --secrets-file`: the owner's Access identities."""
    name = "TODOFY_ACCESS_OWNER_ALIASES"
    if name not in env:
        raise SettingError(name)
    items = [item.strip() for item in env[name].split(",") if item.strip()]
    if (
        len(items) > MAX_ALIASES
        or len(set(items)) != len(items)
        or len(",".join(items)) > MAX_LIST_CHARS
        or not all(EMAIL.fullmatch(item) for item in items)
    ):
        raise SettingError(name)
    return {
        "ACCESS_OWNER": _required(env, "TODOFY_ACCESS_OWNER", EMAIL),
        # --secrets-file only adds or replaces secrets, so an emptied list is uploaded as a single
        # space (the gateway reads it as no aliases) rather than left out, which would keep the
        # previous aliases working.
        "ACCESS_OWNER_ALIASES": ",".join(items) or " ",
    }


def write_secrets(path: Path, env: Mapping[str, str]) -> None:
    """Owner-only, never over an existing file (it may be someone's local file)."""
    secrets = generate_secrets(env)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(json.dumps(secrets, indent=2) + "\n")


def refusal(worker: str, argv: Sequence[str], cwd: Path | None = None) -> str | None:
    """Why `argv` must not run through this wrapper for `worker`, or None."""
    if not argv:
        return "no command given"
    config = None
    for index, arg in enumerate(argv):
        if arg in ("--env", "-e") or arg.startswith("--env=") or (arg.startswith("-e") and not arg.startswith("--")):
            return "--env is not allowed: the top level is production"
        if arg == "--keep-vars" or arg.startswith("--keep-vars="):
            return "--keep-vars is not allowed: the config is the source of truth"
        if arg == "--var" or arg.startswith("--var="):
            return "--var is added by this wrapper only"
        if arg in ("--config", "-c"):
            config = argv[index + 1] if index + 1 < len(argv) else ""
        elif arg.startswith("--config="):
            config = arg.removeprefix("--config=")
    if "deploy" not in argv:
        return "only a deploy (or a --dry-run deploy) runs through this wrapper"
    expected = CONFIGS[worker]
    if not config or (Path(cwd or Path.cwd()) / config).resolve() != expected.resolve():
        return f"--config must name {expected}"
    return None


def _run(argv: Sequence[str], env: Mapping[str, str], spawn: Callable[[list[str]], int]) -> int:
    match list(argv):
        case ["check"]:
            for worker in INJECTED:
                injected_vars(worker, env)
            generate_secrets(env)
            print("Deploy values are valid (not printed).")
            return 0
        case ["secrets", path]:
            write_secrets(Path(path), env)
            print("Wrote the gateway secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES (values not printed).")
            return 0
        case ["exec", worker, "--", *command] if worker in INJECTED:
            if reason := refusal(worker, command):
                print(f"Refused: {reason}.", file=sys.stderr)
                return 2
            extra = wrangler_args(worker, env)
            names = ", ".join(injected_vars(worker, env))  # an unset optional var is not sent
            print(f"Adding --var for {names} (values not printed).", flush=True)
            return spawn([*command, *extra])
    print("Usage: deploy_vars.py check | secrets <path> | exec {core|gateway} -- <deploy command…>", file=sys.stderr)
    return 2


def _spawn(command: list[str]) -> int:
    try:
        return subprocess.run(command, check=False).returncode
    except OSError:
        print(f"Could not start {command[0]}.", file=sys.stderr)
        return 1


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    try:
        return _run(sys.argv[1:] if argv is None else argv, os.environ if env is None else env, _spawn)
    except SettingError as error:
        print(error, file=sys.stderr)
        return 1
    except FileExistsError:
        print("The secrets file already exists; nothing was overwritten.", file=sys.stderr)
        return 1
    except OSError:
        print("Unable to write the secrets file.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
