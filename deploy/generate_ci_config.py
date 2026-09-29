#!/usr/bin/env python3
"""Generate the production Wrangler configs of both Workers from validated GitHub variables and secrets.

Todofy ships two Workers (docs/gateway-contract.md): the TypeScript gateway `todofy` (custom domains, UI
assets, cron, the Durable Object binding) and the Python `todofy-core` (the Durable Object and D1, no
public routes). Each Worker's shape (entry, compatibility date, assets, bindings, migrations, cron) is
copied from its checked-in wrangler.toml so production cannot drift from what the tests run; account,
database, hostnames and vars come from the environment. Messages name variables and never print values,
and dev-only switches (DEV_*) are never emitted.

Wrangler prints every plain var with its value when it deploys, and the repository and its Actions logs
are public. So the owner's email addresses (TODOFY_ACCESS_OWNER and TODOFY_ACCESS_OWNER_ALIASES, GitHub
environment secrets that Actions masks) are not vars: they go to a separate owner-only JSON file that the
gateway deploy passes to `wrangler deploy --secrets-file`, where they become Worker secrets shown as
hidden. Only the gateway checks Access, so the core gets no secrets file.

Each file is written next to the config it derives from on purpose: wrangler resolves `main`, assets,
migrations and, for the core, the vendored `python_modules/` (which holds the `workers` SDK) relative to
the config file, so a config placed elsewhere would bundle a Worker without its code or SDK.
"""

import json
import os
import re
import sys
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
GATEWAY = ROOT / "gateway"
CORE_OUTPUT = ROOT / "wrangler.production.ci.json"
GATEWAY_OUTPUT = GATEWAY / "wrangler.production.ci.json"
SECRETS_OUTPUT = GATEWAY / "wrangler.production.secrets.json"

DOMAIN = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
FLAG = re.compile(r"true|false")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.IGNORECASE)
INTEGER = re.compile(r"0|[1-9][0-9]{0,11}")

MAX_HOOKS_HOSTS = 4
MAX_ALIASES = 8  # the gateway's Access check refuses more aliases, or more than MAX_LIST_CHARS of them
MAX_LIST_CHARS = 2048
MAX_REPORT_TOP = 10  # core.report_schema.MAX_TOP_N
DEFAULT_GEMINI_MODELS = "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite"
# Production upstreams are constants, not variables, so a bad variable cannot send API keys elsewhere.
# Test-only timing knobs (GEMINI_TIMEOUT_MS, BACKOFF_BASE_MS, WATCHDOG_MS, TODOIST_ATTEMPT_TIMEOUT_MS,
# JWKS_REFRESH_COOLDOWN_MS) keep their code defaults.
FIXED_VARS = {
    "GEMINI_API_BASE": "https://generativelanguage.googleapis.com",
    "TODOIST_API_BASE": "https://api.todoist.com",
}
# The keys copied verbatim from each checked-in config. Everything else in a config is replaced here
# (workers_dev, preview_urls, d1_databases, vars); a test fails when a config gains a key neither list has.
CORE_SHAPE_KEYS = ("name", "main", "base_dir", "compatibility_date", "compatibility_flags", "migrations")
GATEWAY_SHAPE_KEYS = ("name", "main", "compatibility_date", "assets", "durable_objects", "migrations", "triggers")


class SettingError(ValueError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Invalid or missing CI setting: {name}")


def _checked(env: Mapping[str, str], name: str, pattern: re.Pattern[str], default: str | None = None) -> str:
    # GitHub passes an unset variable as "", so empty means the default (or missing when there is none).
    value = env.get(name) or default
    if value is None or not pattern.fullmatch(value):
        raise SettingError(name)
    return value


def _integer(env: Mapping[str, str], name: str, default: str, minimum: int, maximum: int) -> str:
    value = _checked(env, name, INTEGER, default)
    if not minimum <= int(value) <= maximum:
        raise SettingError(name)
    return value


def _listed(env: Mapping[str, str], name: str, pattern: re.Pattern[str], limit: int) -> list[str]:
    items = [item.strip() for item in env.get(name, "").split(",") if item.strip()]
    if (
        len(items) > limit
        or len(set(items)) != len(items)
        or len(",".join(items)) > MAX_LIST_CHARS
        or not all(pattern.fullmatch(item) for item in items)
    ):
        raise SettingError(name)
    return items


def _hosts(env: Mapping[str, str]) -> tuple[str, list[str]]:
    public_host = _checked(env, "TODOFY_PUBLIC_HOST", DOMAIN)
    hooks_hosts = _listed(env, "TODOFY_HOOKS_HOSTS", DOMAIN, MAX_HOOKS_HOSTS)
    # The gateway matches the public host first, so a shared name would make the hooks unreachable.
    if not hooks_hosts or public_host in hooks_hosts:
        raise SettingError("TODOFY_HOOKS_HOSTS")
    return public_host, hooks_hosts


def _common(env: Mapping[str, str]) -> dict[str, Any]:
    return {
        "account_id": _checked(env, "CLOUDFLARE_ACCOUNT_ID", re.compile(r"[a-f0-9]{32}", re.IGNORECASE)),
        "workers_dev": False,
        "preview_urls": False,
        "observability": {"enabled": True},
    }


def _shared_vars(env: Mapping[str, str]) -> dict[str, str]:
    """Vars both Workers read; one deploy gives them the same value."""
    return {
        "BUILD_SHA": _checked(env, "GITHUB_SHA", re.compile(r"[0-9a-f]{40}")),
        # Switches have no default: every deploy states each one, as Mail Hero's generator requires.
        "MAINTENANCE_MODE": _checked(env, "TODOFY_MAINTENANCE_MODE", FLAG),
    }


def generate_gateway(env: Mapping[str, str], base: Mapping[str, Any]) -> dict[str, Any]:
    """The `todofy` gateway from `env` (GitHub variables) and `base` (the parsed gateway/wrangler.toml)."""
    public_host, hooks_hosts = _hosts(env)
    return {
        **{key: base[key] for key in GATEWAY_SHAPE_KEYS},
        **_common(env),
        "routes": [{"pattern": host, "custom_domain": True} for host in (public_host, *hooks_hosts)],
        "vars": {
            **_shared_vars(env),
            "TODOFY_PUBLIC_HOST": public_host,
            "TODOFY_HOOKS_HOSTS": ",".join(hooks_hosts),
            "ACCESS_ISSUER": _checked(
                env, "TODOFY_ACCESS_ISSUER", re.compile(r"https://[a-z0-9-]+\.cloudflareaccess\.com")
            ),
            "ACCESS_AUDIENCE": _checked(env, "TODOFY_ACCESS_AUDIENCE", re.compile(r"[a-f0-9]{64}", re.IGNORECASE)),
        },
    }


def generate_core(env: Mapping[str, str], base: Mapping[str, Any]) -> dict[str, Any]:
    """The `todofy-core` Worker from `env` and `base` (the parsed root wrangler.toml). No routes."""
    public_host, _ = _hosts(env)
    database = base["d1_databases"][0]
    return {
        **{key: base[key] for key in CORE_SHAPE_KEYS},
        **_common(env),
        "d1_databases": [
            {
                "binding": database["binding"],
                "database_name": _checked(env, "TODOFY_D1_DATABASE_NAME", re.compile(r"[a-zA-Z0-9_-]{1,63}"), "todofy"),
                "database_id": _checked(env, "TODOFY_D1_DATABASE_ID", UUID),
                "migrations_dir": database["migrations_dir"],
            }
        ],
        "vars": {
            **FIXED_VARS,
            **_shared_vars(env),
            # The daily reminder links to the owner UI.
            "TODOFY_PUBLIC_HOST": public_host,
            "MAIL_SOURCE_ID": _checked(
                env, "TODOFY_MAIL_SOURCE_ID", re.compile(r"[a-z0-9][a-z0-9._-]{0,63}"), "mail-hero-personal"
            ),
            "GEMINI_MODELS": ",".join(_listed(env, "TODOFY_GEMINI_MODELS", re.compile(r"[a-z0-9][a-z0-9.-]{0,63}"), 5))
            or DEFAULT_GEMINI_MODELS,
            "GEMINI_DAILY_TOKEN_BUDGET": _integer(env, "TODOFY_GEMINI_DAILY_TOKEN_BUDGET", "3000000", 1, 1_000_000_000),
            "TODOIST_DEFAULT_PROJECT_ID": _checked(
                env, "TODOFY_TODOIST_DEFAULT_PROJECT_ID", re.compile(r"[A-Za-z0-9_-]{1,64}")
            ),
            "LOOKUP_DELAY_MS": _integer(env, "TODOFY_LOOKUP_DELAY_MS", "120000", 1_000, 3_600_000),
            "REPORT_DEFAULT_TOP": _integer(env, "TODOFY_REPORT_DEFAULT_TOP", "10", 1, MAX_REPORT_TOP),
            "REPORT_PRECOMPUTE_UTC": _checked(
                env, "TODOFY_REPORT_PRECOMPUTE_UTC", re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]"), "13:30"
            ),
            # 0 keeps imported mail text forever.
            "LEGACY_TEXT_RETENTION_DAYS": _integer(env, "TODOFY_LEGACY_TEXT_RETENTION_DAYS", "0", 0, 36_500),
            "REMINDER_ENABLED": _checked(env, "TODOFY_REMINDER_ENABLED", FLAG),
            "PROCESSING_PAUSED": _checked(env, "TODOFY_PROCESSING_PAUSED", FLAG),
            "FORCE_PAUSE_TODOIST": _checked(env, "TODOFY_FORCE_PAUSE_TODOIST", FLAG),
        },
    }


def generate_secrets(env: Mapping[str, str]) -> dict[str, str]:
    """Gateway secrets for `wrangler deploy --secrets-file`: the owner's Access identities."""
    aliases = ",".join(_listed(env, "TODOFY_ACCESS_OWNER_ALIASES", EMAIL, MAX_ALIASES))
    return {
        "ACCESS_OWNER": _checked(env, "TODOFY_ACCESS_OWNER", EMAIL),
        # --secrets-file only adds or replaces secrets, so an emptied list is uploaded as a single
        # space (the gateway reads it as no aliases) rather than left out, which would keep the
        # previous aliases working.
        "ACCESS_OWNER_ALIASES": aliases or " ",
    }


def _write_private(path: Path, data: Mapping[str, Any]) -> None:
    # Never overwrite: an existing file may be someone's local production config.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(json.dumps(data, indent=2) + "\n")


def main(
    core_output: Path = CORE_OUTPUT, gateway_output: Path = GATEWAY_OUTPUT, secrets_output: Path = SECRETS_OUTPUT
) -> int:
    written: list[Path] = []
    try:
        core = generate_core(os.environ, tomllib.loads((ROOT / "wrangler.toml").read_text()))
        gateway = generate_gateway(os.environ, tomllib.loads((GATEWAY / "wrangler.toml").read_text()))
        secrets = generate_secrets(os.environ)
        for path, data in ((core_output, core), (gateway_output, gateway), (secrets_output, secrets)):
            _write_private(path, data)
            written.append(path)
    except SettingError as error:
        print(error, file=sys.stderr)
        return 1
    except FileExistsError:
        for path in written:
            path.unlink()
        print("CI configuration already exists; nothing was overwritten.", file=sys.stderr)
        return 1
    except (OSError, KeyError, IndexError, tomllib.TOMLDecodeError):
        for path in written:
            path.unlink(missing_ok=True)
        print("Unable to generate CI configuration.", file=sys.stderr)
        return 1
    print(
        "Generated production configuration; values were not printed. Core vars: "
        + ", ".join(sorted(core["vars"]))
        + ". Gateway vars: "
        + ", ".join(sorted(gateway["vars"]))
        + ". Gateway secrets file: "
        + ", ".join(sorted(secrets))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
