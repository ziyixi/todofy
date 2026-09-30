"""The committed production configs, wrangler.toml (todofy-core) and gateway/wrangler.toml (todofy).

These are the static checks the retired CI config generator made on GitHub variables.
"""

import re
import tomllib
from typing import Any

import pytest

from deploy.deploy_vars import CONFIGS, INJECTED, ROOT
from todofy.core.report_schema import MAX_TOP_N


def _load(worker: str) -> dict[str, Any]:
    return tomllib.loads(CONFIGS[worker].read_text())


CORE = _load("core")
GATEWAY = _load("gateway")
DOMAIN = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
FIXED_UPSTREAMS = {
    "GEMINI_API_BASE": "https://generativelanguage.googleapis.com",
    "TODOIST_API_BASE": "https://api.todoist.com",
}
# The vars each Worker has in production: committed ones plus the deploy's --var.
CORE_VARS = {
    "GEMINI_API_BASE",
    "TODOIST_API_BASE",
    "TODOFY_PUBLIC_HOST",
    "MAIL_SOURCE_ID",
    "GEMINI_MODELS",
    "GEMINI_DAILY_TOKEN_BUDGET",
    "LOOKUP_DELAY_MS",
    "REPORT_DEFAULT_TOP",
    "REPORT_PRECOMPUTE_UTC",
    "LEGACY_TEXT_RETENTION_DAYS",
}
GATEWAY_VARS = {"TODOFY_PUBLIC_HOST", "TODOFY_HOOKS_HOSTS", "ACCESS_ISSUER", "ACCESS_AUDIENCE"}


def _integer(value: str, minimum: int, maximum: int) -> bool:
    return re.fullmatch(r"0|[1-9][0-9]{0,11}", value) is not None and minimum <= int(value) <= maximum


@pytest.mark.parametrize("worker", ["core", "gateway"])
def test_the_top_level_is_production(worker: str) -> None:
    config = _load(worker)
    assert config["name"] == {"core": "todofy-core", "gateway": "todofy"}[worker]
    assert "env" not in config and "keep_vars" not in config
    assert config["workers_dev"] is False and config["preview_urls"] is False
    assert config["observability"] == {"enabled": True}
    assert not [name for name in config["vars"] if name.startswith("DEV_")]
    assert all(isinstance(value, str) for value in config["vars"].values())
    assert re.fullmatch(r"[a-f0-9]{32}", config["account_id"])
    # Owner emails are Worker secrets (--secrets-file), never vars; no address in a public file.
    assert "@" not in "".join(line for line in CONFIGS[worker].read_text().splitlines() if not line.startswith("#"))


def test_the_committed_vars_are_exactly_the_static_ones() -> None:
    assert set(CORE["vars"]) == CORE_VARS
    assert set(GATEWAY["vars"]) == GATEWAY_VARS
    for worker, config in (("core", CORE), ("gateway", GATEWAY)):
        assert not set(config["vars"]) & {item.name for item in INJECTED[worker]}, worker
    # Test-only timing knobs keep their code defaults; the build is the deploy's commit.
    never = ("GEMINI_TIMEOUT_MS", "BUILD_SHA", "ACCESS_OWNER", "ACCESS_OWNER_ALIASES", "TODOIST_DEFAULT_PROJECT_ID")
    for name in never:
        assert name not in CORE["vars"] and name not in GATEWAY["vars"], name


def test_both_workers_share_account_date_and_public_host() -> None:
    assert CORE["account_id"] == GATEWAY["account_id"]
    assert CORE["compatibility_date"] == GATEWAY["compatibility_date"]
    assert CORE["vars"]["TODOFY_PUBLIC_HOST"] == GATEWAY["vars"]["TODOFY_PUBLIC_HOST"]


def test_core_shape() -> None:
    # pywrangler reads the Python version from this file only: 2026-09-08 + python_workers = Python 3.14.
    assert CONFIGS["core"] == ROOT / "wrangler.toml"
    assert CORE["compatibility_date"] == "2026-09-08"
    assert CORE["compatibility_flags"] == ["python_workers"]
    assert (ROOT / CORE["main"]).is_file() and (ROOT / CORE["base_dir"]).is_dir()
    assert CORE["migrations"] == [
        {"tag": "v1", "new_sqlite_classes": ["TodofyCoordinator"]},
        {"tag": "v2", "renamed_classes": [{"from": "TodofyCoordinator", "to": "TodofyCore"}]},
    ]
    # No public entry and nothing that would give it one.
    for key in ("routes", "assets", "triggers", "durable_objects"):
        assert key not in CORE, key
    [database] = CORE["d1_databases"]
    assert database["binding"] == "DB" and database["migrations_dir"] == "migrations"
    assert (ROOT / database["migrations_dir"]).is_dir()
    assert re.fullmatch(r"[a-zA-Z0-9_-]{1,63}", database["database_name"])
    assert UUID.fullmatch(database["database_id"])
    assert CORE["r2_buckets"] == [{"binding": "BACKUPS", "bucket_name": "todofy-backups"}]


def test_core_vars() -> None:
    variables = CORE["vars"]
    # Fixed upstreams: a setting can never send the API keys elsewhere.
    assert {name: variables[name] for name in FIXED_UPSTREAMS} == FIXED_UPSTREAMS
    assert DOMAIN.fullmatch(variables["TODOFY_PUBLIC_HOST"])
    assert re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", variables["MAIL_SOURCE_ID"])
    models = variables["GEMINI_MODELS"].split(",")
    assert 1 <= len(models) <= 5 and len(set(models)) == len(models)
    assert all(re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", model) for model in models)
    assert _integer(variables["GEMINI_DAILY_TOKEN_BUDGET"], 1, 1_000_000_000)
    assert _integer(variables["LOOKUP_DELAY_MS"], 1_000, 3_600_000)
    assert _integer(variables["REPORT_DEFAULT_TOP"], 1, MAX_TOP_N)
    assert re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", variables["REPORT_PRECOMPUTE_UTC"])
    assert _integer(variables["LEGACY_TEXT_RETENTION_DAYS"], 0, 36_500)


def test_gateway_shape() -> None:
    assert CONFIGS["gateway"] == ROOT / "gateway" / "wrangler.toml"
    assert (CONFIGS["gateway"].parent / GATEWAY["main"]).is_file()
    assert GATEWAY["assets"] == {
        "directory": "../uiassets/dist",
        "binding": "ASSETS",
        "run_worker_first": True,
        "not_found_handling": "single-page-application",
    }
    assert GATEWAY["triggers"] == {"crons": ["*/10 * * * *"]}
    assert GATEWAY["durable_objects"] == {
        "bindings": [{"name": "COORDINATOR", "class_name": "TodofyCore", "script_name": CORE["name"]}]
    }
    # Script "todofy" created the Python class (v1) and deleted it once the gateway replaced it (v2).
    assert GATEWAY["migrations"] == [
        {"tag": "v1", "new_sqlite_classes": ["TodofyCoordinator"]},
        {"tag": "v2", "deleted_classes": ["TodofyCoordinator"]},
    ]
    for key in ("d1_databases", "r2_buckets"):
        assert key not in GATEWAY, key
    for config in (CORE, GATEWAY):
        assert config["analytics_engine_datasets"] == [{"binding": "METRICS", "dataset": "todofy_metrics"}]


def test_gateway_routes_are_the_public_host_then_every_hooks_host() -> None:
    variables = GATEWAY["vars"]
    public_host = variables["TODOFY_PUBLIC_HOST"]
    hooks_hosts = variables["TODOFY_HOOKS_HOSTS"].split(",")
    assert DOMAIN.fullmatch(public_host)
    assert 1 <= len(hooks_hosts) <= 4 and len(set(hooks_hosts)) == len(hooks_hosts)
    assert all(DOMAIN.fullmatch(host) for host in hooks_hosts)
    assert len(",".join(hooks_hosts)) <= 2048
    # The gateway matches the public host first, so a shared name would make the hooks unreachable.
    assert public_host not in hooks_hosts
    assert GATEWAY["routes"] == [{"pattern": host, "custom_domain": True} for host in (public_host, *hooks_hosts)]
    assert re.fullmatch(r"https://[a-z0-9-]+\.cloudflareaccess\.com", variables["ACCESS_ISSUER"])
    assert re.fullmatch(r"[a-f0-9]{64}", variables["ACCESS_AUDIENCE"])


def test_api_upstreams_and_access_settings_stay_on_their_worker() -> None:
    core, gateway = CORE["vars"], GATEWAY["vars"]
    assert not any(name.startswith(("GEMINI_", "TODOIST_")) for name in gateway)
    assert not any(name.startswith("ACCESS_") for name in core)
    assert "TODOFY_HOOKS_HOSTS" not in core
