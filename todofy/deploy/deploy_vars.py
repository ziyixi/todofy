#!/usr/bin/env python3
"""The values of Todofy's two Workers that are never committed, added at deploy time.

The committed production configs are wrangler.toml (todofy-core) and gateway/wrangler.toml (the gateway
`todofy`). What they must not hold is added here:

- `--var NAME:value` (a plain_text var, exactly like a [vars] entry): BUILD_SHA (the commit) and the
  operational switches (GitHub environment variables; a release restates them and never overwrites them)
  on both Workers. Every switch is required.
- `--secrets-file` (Worker secrets: hidden in wrangler's output and in the Cloudflare dashboard and API,
  unlike a plain_text var), one owner-only file per Worker written by the `secrets` mode from GitHub
  environment secrets: the gateway's owner Access emails ACCESS_OWNER and ACCESS_OWNER_ALIASES, and on each
  Worker the secrets of its <APP>_WORKER_SECRETS map (tools/cloud-config) when the release has one. The core
  has no personal value since 2026-10-21: its Tasks projects went with the reminder, the weekly review and the
  mail tasks, and their live secrets stay declared (app.toml) until the owner deletes them.

Wrangler silently DELETES a var that a deploy does not send (no config has keep_vars), so this wrapper
refuses to run unless every value is present and valid, and `exec` refuses a deploy without exactly one
valid --secrets-file for that Worker. A deploy keeps every Worker secret it does not upload, so a value
that may be unset is always uploaded: an empty alias list is uploaded as a single space, which the gateway
reads as unset (it trims the list). Leaving it out would keep the previous value working. Messages name the
setting, never a value.

    uv run python deploy/deploy_vars.py check
    uv run python deploy/deploy_vars.py secrets core "$RUNNER_TEMP/todofy-core-secrets.json"
    uv run python deploy/deploy_vars.py secrets gateway "$RUNNER_TEMP/todofy-gateway-secrets.json"
    uv run python deploy/deploy_vars.py exec core -- uv run pywrangler deploy [--dry-run] --config wrangler.toml \\
        --secrets-file "$RUNNER_TEMP/todofy-core-secrets.json"
    uv run python deploy/deploy_vars.py exec gateway -- npx --no-install wrangler deploy [--dry-run] \\
        --config gateway/wrangler.toml --secrets-file "$RUNNER_TEMP/todofy-gateway-secrets.json"
"""

# .github/scripts/test_wrangler_configs.py reads these lines (a mode may take several): every CI step that
# runs `exec core`, `exec gateway`, `secrets core` or `secrets gateway` must set each input of that mode
# (modes core, gateway, secrets_core, secrets_gateway; Actions sets GITHUB_*). `secrets core` has no line: the
# core has no personal value, and the GitHub maps (<APP>_WORKER_SECRETS) are never listed.
# deploy-vars-inputs core: GITHUB_SHA TODOFY_MAINTENANCE_MODE TODOFY_PROCESSING_PAUSED
# deploy-vars-inputs gateway: GITHUB_SHA TODOFY_MAINTENANCE_MODE
# deploy-vars-inputs secrets_gateway: TODOFY_ACCESS_OWNER TODOFY_ACCESS_OWNER_ALIASES

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
WORKER_NAMES = {"core": "todofy-core", "gateway": "todofy"}
SECRET_SPECS = json.loads((ROOT.parent / "tools/cloud-config/worker-secrets.json").read_text())

# Printable ASCII only, as packages/edge-auth requires of the owner and aliases (SPEC.md #36).
EMAIL = re.compile(r"(?=[\x21-\x7e]+\Z)[^\s@]+@[^\s@]+\.[^\s@]+")
FLAG = re.compile(r"true|false")
SHA = re.compile(r"[0-9a-f]{40}")
MAX_ALIASES = 8  # the gateway's Access check refuses more aliases, or more than MAX_LIST_CHARS of them
MAX_LIST_CHARS = 2048
# What an unset optional secret is uploaded as (see the module docstring): the gateway reads it as unset.
UNSET = " "


class SettingError(ValueError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Invalid or missing deploy setting: {name}")
        self.setting = name


@dataclass(frozen=True)
class Injected:
    name: str  # the Worker binding
    source: str  # the environment variable CI sets
    kind: str  # "build", "toggle", "personal" or "optional" (a personal value that may be unset)
    pattern: re.Pattern[str]


def _shared() -> tuple[Injected, ...]:
    return (
        Injected("BUILD_SHA", "GITHUB_SHA", "build", SHA),
        # One value on both Workers: every deploy states it, and both deploys read the same variable.
        Injected("MAINTENANCE_MODE", "TODOFY_MAINTENANCE_MODE", "toggle", FLAG),
    )


# The --var values of each Worker, in deploy order.
INJECTED: dict[str, tuple[Injected, ...]] = {
    "core": (
        *_shared(),
        Injected("PROCESSING_PAUSED", "TODOFY_PROCESSING_PAUSED", "toggle", FLAG),
    ),
    "gateway": _shared(),
}

# The personal Worker secrets of each Worker (its --secrets-file). The gateway's alias list is validated as a list.
SECRETS: dict[str, tuple[Injected, ...]] = {
    "core": (),
    "gateway": (
        Injected("ACCESS_OWNER", "TODOFY_ACCESS_OWNER", "personal", EMAIL),
        Injected("ACCESS_OWNER_ALIASES", "TODOFY_ACCESS_OWNER_ALIASES", "optional", EMAIL),
    ),
}
SECRET_INPUTS = {worker: tuple(item.source for item in items) for worker, items in SECRETS.items()}


def _required(env: Mapping[str, str], name: str, pattern: re.Pattern[str]) -> str:
    # GitHub passes an unset variable as "": no identity and no switch has a default, so empty is missing too.
    value = env.get(name)
    if not value or not pattern.fullmatch(value):
        raise SettingError(name)
    return value


def _aliases(env: Mapping[str, str]) -> str:
    """The gateway's alias list, normalized ("" for none). It must be present: the CI step that writes the
    gateway's secrets always states it."""
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
    return ",".join(items)


def injected_vars(worker: str, env: Mapping[str, str]) -> dict[str, str]:
    """{NAME: value} for every --var `worker` ("core" or "gateway") gets at deploy."""
    return {
        item.name: _required(
            env,
            "BUILD_SOURCE_SHA" if item.kind == "build" and env.get("BUILD_SOURCE_SHA") else item.source,
            item.pattern,
        )
        for item in INJECTED[worker]
    }


def wrangler_args(worker: str, env: Mapping[str, str]) -> list[str]:
    """The flags appended to the deploy command (wrangler splits --var at the first colon)."""
    return [flag for name, value in injected_vars(worker, env).items() for flag in ("--var", f"{name}:{value}")]


def generate_secrets(worker: str, env: Mapping[str, str]) -> dict[str, str]:
    """{NAME: value} of `worker`'s secrets file, for `wrangler deploy --secrets-file`. Every name is always
    present: an unset optional value is uploaded as UNSET so that it replaces a previous value."""
    secrets = {}
    for item in SECRETS[worker]:
        value = _aliases(env) if item.name == "ACCESS_OWNER_ALIASES" else _required(env, item.source, item.pattern)
        secrets[item.name] = value or UNSET
    return _merge_worker_secrets(worker, env, secrets)


def _valid_worker_secrets(worker: str, content: object, *, complete: bool) -> bool:
    spec = SECRET_SPECS[WORKER_NAMES[worker]]
    allowed = set(spec["required"]) | set(spec["optional"])
    return (
        isinstance(content, dict)
        and all(
            name in allowed and isinstance(value, str) and 0 < len(value) <= 65536 and "\0" not in value
            for name, value in content.items()
        )
        and (not complete or set(spec["required"]) <= content.keys())
    )


def _merge_worker_secrets(worker: str, env: Mapping[str, str], personal: dict[str, str]) -> dict[str, str]:
    spec = SECRET_SPECS[WORKER_NAMES[worker]]
    field = spec["github_secret"]
    required = env.get("REQUIRE_COMPLETE_WORKER_SECRETS", "")
    if required not in ("", "true", "false"):
        raise SettingError("REQUIRE_COMPLETE_WORKER_SECRETS")
    raw = env.get(field)
    if not raw:
        if required == "true":
            raise SettingError(field)
        return personal
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise SettingError(field) from error
    if isinstance(parsed, dict):
        if worker == "gateway":
            parsed.pop("CSRF_SIGNING_KEY", None)
        elif worker == "core":
            # Older encrypted GitHub maps may retain this retired provider key; never upload it.
            parsed.pop("GEMINI_API_KEY", None)
    if not _valid_worker_secrets(worker, parsed, complete=False):
        raise SettingError(field)
    merged = {**parsed, **personal}
    if not _valid_worker_secrets(worker, merged, complete=True):
        raise SettingError(field)
    return merged


def write_secrets(worker: str, path: Path, env: Mapping[str, str]) -> list[str]:
    """Owner-only, never over an existing file (it may be someone's local file). Returns the names written."""
    secrets = generate_secrets(worker, env)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(json.dumps(secrets, indent=2) + "\n")
    return sorted(secrets)


def _valid_secret(item: Injected, value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    if item.kind == "optional" and value == UNSET:
        return True
    if item.name == "ACCESS_OWNER_ALIASES":
        try:
            return _aliases({item.source: value}) == value
        except SettingError:
            return False
    return item.pattern.fullmatch(value) is not None


def secrets_file_problem(worker: str, path: Path) -> str | None:
    """Why the secrets file at `path` must not be deployed for `worker`, or None: it must hold exactly that
    Worker's secrets, each valid as `secrets` writes it (never printed)."""
    try:
        content = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, ValueError):
        return "the --secrets-file is missing or not JSON"
    names = [item.name for item in SECRETS[worker]]
    if not _valid_worker_secrets(worker, content, complete=False) or not set(names) <= content.keys():
        return f"the --secrets-file must hold {', '.join(names)} and only declared bindings"
    for item in SECRETS[worker]:
        if not _valid_secret(item, content[item.name]):
            return f"{item.name} in the --secrets-file is invalid"
    return None


def refusal(worker: str, argv: Sequence[str], cwd: Path | None = None) -> str | None:
    """Why `argv` must not run through this wrapper for `worker`, or None. `cwd` resolves a relative
    --config and --secrets-file."""
    if not argv:
        return "no command given"
    base = Path(cwd or Path.cwd())
    config = None
    secrets_files = []
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
        elif arg == "--secrets-file":
            secrets_files.append(argv[index + 1] if index + 1 < len(argv) else "")
        elif arg.startswith("--secrets-file="):
            secrets_files.append(arg.removeprefix("--secrets-file="))
    if "deploy" not in argv:
        return "only a deploy (or a --dry-run deploy) runs through this wrapper"
    expected = CONFIGS[worker]
    if not config or (base / config).resolve() != expected.resolve():
        return f"--config must name {expected}"
    # Without the file the deploy would keep a previous value of a secret this deploy means to replace.
    if len(secrets_files) != 1 or not secrets_files[0]:
        return f"exactly one --secrets-file (written by `secrets {worker}`) is required"
    return secrets_file_problem(worker, base / secrets_files[0])


def _run(argv: Sequence[str], env: Mapping[str, str], spawn: Callable[[list[str]], int]) -> int:
    match list(argv):
        case ["check"]:
            for worker in INJECTED:
                injected_vars(worker, env)
                generate_secrets(worker, env)
            print("Deploy values are valid (not printed).")
            return 0
        case ["secrets", worker, path] if worker in SECRETS:
            names = ", ".join(write_secrets(worker, Path(path), env)) or "no secret"
            print(f"Wrote the {worker} secrets file: {names} (values not printed).")
            return 0
        case ["exec", worker, "--", *command] if worker in INJECTED:
            if reason := refusal(worker, command):
                print(f"Refused: {reason}.", file=sys.stderr)
                return 2
            extra = wrangler_args(worker, env)
            names = ", ".join(injected_vars(worker, env))
            print(
                f"Adding --var for {names}; the Worker secrets come from --secrets-file (values not printed).",
                flush=True,
            )
            return spawn([*command, *extra])
    print(
        "Usage: deploy_vars.py check | secrets {core|gateway} <path> | exec {core|gateway} -- <deploy command…>",
        file=sys.stderr,
    )
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
