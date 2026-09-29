#!/usr/bin/env python3
"""Generate the production Wrangler config from validated GitHub variables.

Python twin of Mail Hero's deploy/generate-ci-config.mjs. The Worker shape (entry, compatibility date and
flags, assets, bindings, cron) is copied from wrangler.toml so production cannot drift from what the tests
run; account, database, hostnames and vars come from the environment. Messages name variables and never
print values, and dev-only switches (DEV_*) are never emitted.

The file is written next to wrangler.toml on purpose: wrangler resolves `main`, assets, migrations and the
vendored `python_modules/` (which holds the `workers` SDK) relative to the config file, so a config placed
elsewhere would bundle a Worker without its SDK.
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
OUTPUT = ROOT / "wrangler.production.ci.json"

DOMAIN = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
FLAG = re.compile(r"true|false")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.IGNORECASE)
INTEGER = re.compile(r"0|[1-9][0-9]{0,11}")

MAX_HOOKS_HOSTS = 4
MAX_ALIASES = 8  # access_jwt refuses more aliases, or more than MAX_LIST_CHARS of them
MAX_LIST_CHARS = 2048
MAX_REPORT_TOP = 10  # core.report_schema.MAX_TOP_N
DEFAULT_GEMINI_MODELS = "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite"
# Production upstreams are constants, not variables, so a bad variable cannot send API keys elsewhere.
# Test-only timing knobs (GEMINI_TIMEOUT_MS, BACKOFF_BASE_MS, WATCHDOG_MS) keep their code defaults.
FIXED_VARS = {
    "GEMINI_API_BASE": "https://generativelanguage.googleapis.com",
    "TODOIST_API_BASE": "https://api.todoist.com",
}
SHAPE_KEYS = ("name", "main", "base_dir", "compatibility_date", "compatibility_flags", "assets")
BINDING_KEYS = ("durable_objects", "migrations", "triggers")


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


def _vars(env: Mapping[str, str], public_host: str, hooks_hosts: list[str]) -> dict[str, str]:
    return {
        **FIXED_VARS,
        "TODOFY_PUBLIC_HOST": public_host,
        "TODOFY_HOOKS_HOSTS": ",".join(hooks_hosts),
        "BUILD_SHA": _checked(env, "GITHUB_SHA", re.compile(r"[0-9a-f]{40}")),
        "MAIL_SOURCE_ID": _checked(
            env, "TODOFY_MAIL_SOURCE_ID", re.compile(r"[a-z0-9][a-z0-9._-]{0,63}"), "mail-hero-personal"
        ),
        "ACCESS_ISSUER": _checked(
            env, "TODOFY_ACCESS_ISSUER", re.compile(r"https://[a-z0-9-]+\.cloudflareaccess\.com")
        ),
        "ACCESS_AUDIENCE": _checked(env, "TODOFY_ACCESS_AUDIENCE", re.compile(r"[a-f0-9]{64}", re.IGNORECASE)),
        "ACCESS_OWNER": _checked(env, "TODOFY_ACCESS_OWNER", EMAIL),
        "ACCESS_OWNER_ALIASES": ",".join(_listed(env, "TODOFY_ACCESS_OWNER_ALIASES", EMAIL, MAX_ALIASES)),
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
        # Switches have no default: every deploy states each one, as Mail Hero's generator requires.
        "REMINDER_ENABLED": _checked(env, "TODOFY_REMINDER_ENABLED", FLAG),
        "MAINTENANCE_MODE": _checked(env, "TODOFY_MAINTENANCE_MODE", FLAG),
        "PROCESSING_PAUSED": _checked(env, "TODOFY_PROCESSING_PAUSED", FLAG),
        "FORCE_PAUSE_TODOIST": _checked(env, "TODOFY_FORCE_PAUSE_TODOIST", FLAG),
    }


def generate_config(env: Mapping[str, str], base: Mapping[str, Any]) -> dict[str, Any]:
    """Build the production config from `env` (GitHub variables) and `base` (the parsed wrangler.toml)."""
    public_host = _checked(env, "TODOFY_PUBLIC_HOST", DOMAIN)
    hooks_hosts = _listed(env, "TODOFY_HOOKS_HOSTS", DOMAIN, MAX_HOOKS_HOSTS)
    # entry.py matches the public host first, so a shared name would make the hooks unreachable.
    if not hooks_hosts or public_host in hooks_hosts:
        raise SettingError("TODOFY_HOOKS_HOSTS")
    database = base["d1_databases"][0]
    return {
        **{key: base[key] for key in SHAPE_KEYS},
        "account_id": _checked(env, "CLOUDFLARE_ACCOUNT_ID", re.compile(r"[a-f0-9]{32}", re.IGNORECASE)),
        "workers_dev": False,
        "preview_urls": False,
        "d1_databases": [
            {
                "binding": database["binding"],
                "database_name": _checked(env, "TODOFY_D1_DATABASE_NAME", re.compile(r"[a-zA-Z0-9_-]{1,63}"), "todofy"),
                "database_id": _checked(env, "TODOFY_D1_DATABASE_ID", UUID),
                "migrations_dir": database["migrations_dir"],
            }
        ],
        **{key: base[key] for key in BINDING_KEYS},
        "observability": {"enabled": True},
        "routes": [{"pattern": host, "custom_domain": True} for host in (public_host, *hooks_hosts)],
        "vars": _vars(env, public_host, hooks_hosts),
    }


def main(output: Path = OUTPUT) -> int:
    try:
        config = generate_config(os.environ, tomllib.loads((ROOT / "wrangler.toml").read_text()))
        # Never overwrite: an existing file may be someone's local production config.
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(json.dumps(config, indent=2) + "\n")
    except SettingError as error:
        print(error, file=sys.stderr)
        return 1
    except FileExistsError:
        print("CI configuration already exists; nothing was overwritten.", file=sys.stderr)
        return 1
    except (OSError, KeyError, IndexError, tomllib.TOMLDecodeError):
        print("Unable to generate CI configuration.", file=sys.stderr)
        return 1
    print("Generated production configuration; values were not printed. Vars: " + ", ".join(sorted(config["vars"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
