"""Unit tests for the production config generator (host CPython, no Cloudflare access)."""

import json
import re
import stat
import tomllib
from pathlib import Path

import pytest

from deploy.generate_ci_config import (
    CORE_SHAPE_KEYS,
    FIXED_VARS,
    GATEWAY,
    GATEWAY_SHAPE_KEYS,
    MAX_REPORT_TOP,
    ROOT,
    SettingError,
    generate_core,
    generate_gateway,
    generate_secrets,
    main,
)
from todofy.core.report_schema import MAX_TOP_N

CORE_BASE = tomllib.loads((ROOT / "wrangler.toml").read_text())
GATEWAY_BASE = tomllib.loads((GATEWAY / "wrangler.toml").read_text())
SHA = "0123456789abcdef0123456789abcdef01234567"
VALID = {
    "CLOUDFLARE_ACCOUNT_ID": "0" * 32,
    "TODOFY_D1_DATABASE_ID": "00000000-0000-4000-8000-000000000000",
    "TODOFY_PUBLIC_HOST": "todofy.example.com",
    "TODOFY_HOOKS_HOSTS": "todofy-hooks.example.com",
    "TODOFY_ACCESS_ISSUER": "https://example.cloudflareaccess.com",
    "TODOFY_ACCESS_AUDIENCE": "0" * 64,
    "TODOFY_ACCESS_OWNER": "owner@example.com",
    "TODOFY_TODOIST_DEFAULT_PROJECT_ID": "6Jf8VQXxpwv56VQ7",
    "TODOFY_REMINDER_ENABLED": "false",
    "TODOFY_MAINTENANCE_MODE": "false",
    "TODOFY_PROCESSING_PAUSED": "false",
    "TODOFY_FORCE_PAUSE_TODOIST": "false",
    "GITHUB_SHA": SHA,
}
REQUIRED = sorted(VALID)
OPTIONAL = [
    "TODOFY_D1_DATABASE_NAME",
    "TODOFY_MAIL_SOURCE_ID",
    "TODOFY_ACCESS_OWNER_ALIASES",
    "TODOFY_GEMINI_MODELS",
    "TODOFY_GEMINI_DAILY_TOKEN_BUDGET",
    "TODOFY_LOOKUP_DELAY_MS",
    "TODOFY_REPORT_DEFAULT_TOP",
    "TODOFY_REPORT_PRECOMPUTE_UTC",
    "TODOFY_LEGACY_TEXT_RETENTION_DAYS",
]
GATEWAY_VARS = {
    "BUILD_SHA",
    "MAINTENANCE_MODE",
    "TODOFY_PUBLIC_HOST",
    "TODOFY_HOOKS_HOSTS",
    "ACCESS_ISSUER",
    "ACCESS_AUDIENCE",
}
CORE_VARS = {
    "GEMINI_API_BASE",
    "TODOIST_API_BASE",
    "BUILD_SHA",
    "MAINTENANCE_MODE",
    "TODOFY_PUBLIC_HOST",
    "MAIL_SOURCE_ID",
    "GEMINI_MODELS",
    "GEMINI_DAILY_TOKEN_BUDGET",
    "TODOIST_DEFAULT_PROJECT_ID",
    "LOOKUP_DELAY_MS",
    "REPORT_DEFAULT_TOP",
    "REPORT_PRECOMPUTE_UTC",
    "LEGACY_TEXT_RETENTION_DAYS",
    "REMINDER_ENABLED",
    "PROCESSING_PAUSED",
    "FORCE_PAUSE_TODOIST",
}
# Keys the generator sets itself instead of copying them from a checked-in config.
REPLACED_KEYS = {"workers_dev", "preview_urls", "d1_databases", "vars"}


def generate(**overrides: str) -> dict[str, dict]:
    """Everything main writes, keyed by Worker: core config, gateway config and gateway secrets."""
    env = VALID | overrides
    return {
        "core": generate_core(env, CORE_BASE),
        "gateway": generate_gateway(env, GATEWAY_BASE),
        "secrets": generate_secrets(env),
    }


def test_every_key_of_the_checked_in_configs_is_copied_or_replaced() -> None:
    # A new key in either wrangler.toml must be handled here, or production would silently lack it.
    assert set(CORE_BASE) <= set(CORE_SHAPE_KEYS) | REPLACED_KEYS
    assert set(GATEWAY_BASE) <= set(GATEWAY_SHAPE_KEYS) | REPLACED_KEYS


def test_core_shape_is_the_shipped_root_wrangler_toml() -> None:
    core = generate()["core"]
    for key in CORE_SHAPE_KEYS:
        assert core[key] == CORE_BASE[key], key
    assert core["name"] == "todofy-core"
    # pywrangler reads the Python version from the root config: 2026-09-08 + python_workers = Python 3.14.
    assert core["compatibility_date"] == "2026-09-08"
    assert core["compatibility_flags"] == ["python_workers"]
    assert core["migrations"] == [
        {"tag": "v1", "new_sqlite_classes": ["TodofyCoordinator"]},
        {"tag": "v2", "renamed_classes": [{"from": "TodofyCoordinator", "to": "TodofyCore"}]},
    ]
    # No public entry and nothing that would give it one.
    for key in ("routes", "assets", "triggers", "durable_objects"):
        assert key not in core, key
    assert core["workers_dev"] is False and core["preview_urls"] is False
    assert core["observability"] == {"enabled": True}


def test_core_binds_the_private_backup_bucket() -> None:
    assert generate()["core"]["r2_buckets"] == [{"binding": "BACKUPS", "bucket_name": "todofy-backups"}]
    assert "r2_buckets" not in generate()["gateway"]


def test_gateway_shape_is_the_shipped_gateway_wrangler_toml() -> None:
    gateway = generate()["gateway"]
    for key in GATEWAY_SHAPE_KEYS:
        assert gateway[key] == GATEWAY_BASE[key], key
    assert gateway["name"] == "todofy"
    assert gateway["triggers"] == {"crons": ["*/10 * * * *"]}
    assert gateway["assets"]["directory"] == "../uiassets/dist"
    assert gateway["assets"]["run_worker_first"] is True
    assert gateway["assets"]["not_found_handling"] == "single-page-application"
    assert "d1_databases" not in gateway
    assert gateway["workers_dev"] is False and gateway["preview_urls"] is False
    assert gateway["observability"] == {"enabled": True}


def test_both_workers_write_to_the_same_metrics_dataset() -> None:
    config = generate()
    for worker in (config["core"], config["gateway"]):
        assert worker["analytics_engine_datasets"] == [{"binding": "METRICS", "dataset": "todofy_metrics"}]


def test_gateway_binds_the_core_object_and_deletes_its_own_old_class() -> None:
    config = generate()
    core, gateway = config["core"], config["gateway"]
    assert gateway["durable_objects"] == {
        "bindings": [{"name": "COORDINATOR", "class_name": "TodofyCore", "script_name": core["name"]}]
    }
    assert "TodofyCoordinator" in core["migrations"][0]["new_sqlite_classes"]
    # Script "todofy" keeps its applied v1; a gateway-only release of its own deletes the retired
    # class later, so a refusal (error 10061) cannot hold up this release.
    assert gateway["migrations"] == [
        {"tag": "v1", "new_sqlite_classes": ["TodofyCoordinator"]},
    ]


def test_valid_variables_fill_account_database_routes_and_vars() -> None:
    config = generate()
    core, gateway = config["core"], config["gateway"]
    assert core["account_id"] == gateway["account_id"] == "0" * 32
    assert core["d1_databases"] == [
        {
            "binding": "DB",
            "database_name": "todofy",
            "database_id": "00000000-0000-4000-8000-000000000000",
            "migrations_dir": "migrations",
        }
    ]
    assert gateway["routes"] == [
        {"pattern": "todofy.example.com", "custom_domain": True},
        {"pattern": "todofy-hooks.example.com", "custom_domain": True},
    ]
    assert set(gateway["vars"]) == GATEWAY_VARS
    assert set(core["vars"]) == CORE_VARS
    for worker in (core, gateway):
        assert all(isinstance(value, str) for value in worker["vars"].values())


def test_shared_vars_have_one_value_on_both_workers() -> None:
    config = generate(TODOFY_MAINTENANCE_MODE="true")
    core, gateway = config["core"]["vars"], config["gateway"]["vars"]
    for name in ("BUILD_SHA", "MAINTENANCE_MODE", "TODOFY_PUBLIC_HOST"):
        assert core[name] == gateway[name], name
    assert core["MAINTENANCE_MODE"] == "true"
    assert core["TODOFY_PUBLIC_HOST"] == "todofy.example.com"


def test_defaults_apply_when_optional_variables_are_unset_or_empty() -> None:
    expected = {
        "MAIL_SOURCE_ID": "mail-hero-personal",
        "GEMINI_MODELS": "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite",
        "GEMINI_DAILY_TOKEN_BUDGET": "3000000",
        "LOOKUP_DELAY_MS": "120000",
        "REPORT_DEFAULT_TOP": "10",
        "REPORT_PRECOMPUTE_UTC": "13:30",
        "LEGACY_TEXT_RETENTION_DAYS": "0",
    }
    for config in (generate(), generate(**dict.fromkeys(OPTIONAL, ""))):
        assert {name: config["core"]["vars"][name] for name in expected} == expected
        assert config["core"]["d1_databases"][0]["database_name"] == "todofy"
        # An empty alias list replaces the previous aliases instead of leaving them in place.
        assert config["secrets"]["ACCESS_OWNER_ALIASES"] == " "


def test_optional_variables_are_passed_through_when_valid() -> None:
    config = generate(
        TODOFY_D1_DATABASE_NAME="todofy-prod",
        TODOFY_ACCESS_OWNER_ALIASES=" alias@example.org , other@example.net ",
        TODOFY_GEMINI_MODELS="gemini-3.7-flash",
        TODOFY_REPORT_DEFAULT_TOP="5",
        TODOFY_REPORT_PRECOMPUTE_UTC="23:59",
        TODOFY_LEGACY_TEXT_RETENTION_DAYS="90",
    )
    core = config["core"]
    assert core["d1_databases"][0]["database_name"] == "todofy-prod"
    assert config["secrets"] == {
        "ACCESS_OWNER": "owner@example.com",
        "ACCESS_OWNER_ALIASES": "alias@example.org,other@example.net",
    }
    assert core["vars"]["GEMINI_MODELS"] == "gemini-3.7-flash"
    assert core["vars"]["REPORT_DEFAULT_TOP"] == "5"
    assert core["vars"]["REPORT_PRECOMPUTE_UTC"] == "23:59"
    assert core["vars"]["LEGACY_TEXT_RETENTION_DAYS"] == "90"


def test_build_sha_is_the_40_hex_commit() -> None:
    config = generate()
    for worker in ("core", "gateway"):
        build = config[worker]["vars"]["BUILD_SHA"]
        assert build == SHA and re.fullmatch(r"[0-9a-f]{40}", build)


def test_owner_emails_are_gateway_secrets_never_plain_vars() -> None:
    # Wrangler prints plain vars with their values in the public Actions log.
    config = generate(TODOFY_ACCESS_OWNER_ALIASES="alias@example.org")
    plain = json.dumps([config["core"], config["gateway"]])
    assert "owner@example.com" not in plain and "alias@example.org" not in plain
    assert set(config["secrets"]) == {"ACCESS_OWNER", "ACCESS_OWNER_ALIASES"}


def test_api_upstreams_and_access_settings_stay_on_their_worker() -> None:
    config = generate()
    core, gateway = config["core"]["vars"], config["gateway"]["vars"]
    # Only the core calls Gemini and Todoist; only the gateway checks Access and routes hosts.
    assert not any(name.startswith(("GEMINI_", "TODOIST_")) for name in gateway)
    assert not any(name.startswith("ACCESS_") for name in core)
    assert "TODOFY_HOOKS_HOSTS" not in core


def test_dev_switches_are_never_emitted() -> None:
    config = generate(DEV_AUTH_BYPASS="true", DEV_ACCESS_LOOPBACK_ISSUER="true", DEV_FAKES="true")
    assert "DEV_" not in json.dumps(config)


def test_every_hooks_host_gets_a_custom_domain_route() -> None:
    config = generate(TODOFY_HOOKS_HOSTS="todofy-hooks.example.com, hooks-b.example.com")
    gateway = config["gateway"]
    assert [route["pattern"] for route in gateway["routes"]] == [
        "todofy.example.com",
        "todofy-hooks.example.com",
        "hooks-b.example.com",
    ]
    assert all(route["custom_domain"] is True for route in gateway["routes"])
    assert gateway["vars"]["TODOFY_HOOKS_HOSTS"] == "todofy-hooks.example.com,hooks-b.example.com"
    assert "routes" not in config["core"]


@pytest.mark.parametrize(
    "hosts",
    [
        "",
        " , ",
        "todofy.example.com",  # the public host would shadow the hooks routes
        "todofy-hooks.example.com,todofy-hooks.example.com",
        "a.example.com,b.example.com,c.example.com,d.example.com,e.example.com",
        "https://todofy-hooks.example.com",
        "Todofy-Hooks.example.com",
    ],
)
def test_bad_hooks_host_lists_are_rejected(hosts: str) -> None:
    with pytest.raises(SettingError, match=r"TODOFY_HOOKS_HOSTS$"):
        generate(TODOFY_HOOKS_HOSTS=hosts)


@pytest.mark.parametrize("name", REQUIRED)
def test_every_required_variable_must_be_set(name: str) -> None:
    for env in ({key: value for key, value in VALID.items() if key != name}, VALID | {name: ""}):
        with pytest.raises(SettingError, match=rf"{name}$"):
            generate_core(env, CORE_BASE) | generate_gateway(env, GATEWAY_BASE) | generate_secrets(env)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("CLOUDFLARE_ACCOUNT_ID", "0" * 31),
        ("CLOUDFLARE_ACCOUNT_ID", "g" * 32),
        ("TODOFY_D1_DATABASE_ID", "00000000-0000-0000-0000-000000000000"),
        ("TODOFY_D1_DATABASE_ID", "not-a-uuid"),
        ("TODOFY_D1_DATABASE_NAME", "todofy prod"),
        ("TODOFY_PUBLIC_HOST", "todofy.localhost."),
        ("TODOFY_PUBLIC_HOST", " todofy.example.com"),
        ("TODOFY_PUBLIC_HOST", "todofy.example.com/"),
        ("TODOFY_ACCESS_ISSUER", "http://example.cloudflareaccess.com"),
        ("TODOFY_ACCESS_ISSUER", "https://example.cloudflareaccess.com/"),
        ("TODOFY_ACCESS_ISSUER", "https://127.0.0.1:8787"),
        ("TODOFY_ACCESS_AUDIENCE", "0" * 63),
        ("TODOFY_ACCESS_OWNER", "owner"),
        ("TODOFY_ACCESS_OWNER", "owner@example.com "),
        ("TODOFY_ACCESS_OWNER_ALIASES", "not-an-email"),
        ("TODOFY_ACCESS_OWNER_ALIASES", ",".join(f"a{index}@example.com" for index in range(9))),
        ("TODOFY_ACCESS_OWNER_ALIASES", ",".join(f"{'a' * 300}{index}@example.com" for index in range(8))),
        ("TODOFY_MAIL_SOURCE_ID", "Mail Hero"),
        ("TODOFY_GEMINI_MODELS", "gemini flash"),
        ("TODOFY_GEMINI_DAILY_TOKEN_BUDGET", "0"),
        ("TODOFY_GEMINI_DAILY_TOKEN_BUDGET", "3e6"),
        ("TODOFY_TODOIST_DEFAULT_PROJECT_ID", "inbox project"),
        ("TODOFY_LOOKUP_DELAY_MS", "999"),
        ("TODOFY_LOOKUP_DELAY_MS", "0120000"),
        ("TODOFY_REPORT_DEFAULT_TOP", "0"),
        ("TODOFY_REPORT_DEFAULT_TOP", "11"),
        ("TODOFY_REPORT_DEFAULT_TOP", "-1"),
        ("TODOFY_REPORT_PRECOMPUTE_UTC", "24:00"),
        ("TODOFY_REPORT_PRECOMPUTE_UTC", "9:30"),
        ("TODOFY_LEGACY_TEXT_RETENTION_DAYS", "36501"),
        ("TODOFY_REMINDER_ENABLED", "True"),
        ("TODOFY_MAINTENANCE_MODE", "1"),
        ("TODOFY_PROCESSING_PAUSED", "yes"),
        ("TODOFY_FORCE_PAUSE_TODOIST", "false "),
        ("GITHUB_SHA", SHA[:39]),
        ("GITHUB_SHA", SHA.upper()),
    ],
)
def test_invalid_values_name_only_the_variable(name: str, value: str) -> None:
    with pytest.raises(SettingError) as raised:
        generate(**{name: value})
    assert str(raised.value) == f"Invalid or missing CI setting: {name}"


def test_limits_match_the_worker() -> None:
    assert MAX_REPORT_TOP == MAX_TOP_N
    # The local core config and production talk to the same upstreams.
    assert {name: CORE_BASE["vars"][name] for name in FIXED_VARS} == FIXED_VARS


def _outputs(tmp_path: Path) -> tuple[Path, Path, Path]:
    return tmp_path / "core.json", tmp_path / "gateway.json", tmp_path / "secrets.json"


def test_main_writes_private_files_and_prints_only_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    env = VALID | {"TODOFY_ACCESS_OWNER_ALIASES": "alias@example.org"}
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    core, gateway, secrets = outputs = _outputs(tmp_path)
    assert main(*outputs) == 0
    for path in outputs:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(core.read_text()) == generate_core(env, CORE_BASE)
    assert json.loads(gateway.read_text()) == generate_gateway(env, GATEWAY_BASE)
    assert json.loads(secrets.read_text()) == {
        "ACCESS_OWNER": "owner@example.com",
        "ACCESS_OWNER_ALIASES": "alias@example.org",
    }
    printed = capsys.readouterr()
    assert "ACCESS_OWNER" in printed.out
    for value in env.values():
        assert value not in printed.out + printed.err


@pytest.mark.parametrize("existing", range(3))
def test_main_never_overwrites_an_existing_file(
    existing: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in VALID.items():
        monkeypatch.setenv(name, value)
    outputs = _outputs(tmp_path)
    outputs[existing].write_text("local")
    assert main(*outputs) == 1
    assert outputs[existing].read_text() == "local"
    # Files written before the clash are removed again.
    assert [path.exists() for path in outputs] == [index == existing for index in range(3)]
    assert "already exists" in capsys.readouterr().err


def test_main_reports_the_bad_variable_without_its_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in VALID.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("TODOFY_ACCESS_AUDIENCE", "secret-looking-value")
    outputs = _outputs(tmp_path)
    assert main(*outputs) == 1
    assert not any(path.exists() for path in outputs)
    printed = capsys.readouterr()
    assert printed.err.strip() == "Invalid or missing CI setting: TODOFY_ACCESS_AUDIENCE"
    assert "secret-looking-value" not in printed.out + printed.err
