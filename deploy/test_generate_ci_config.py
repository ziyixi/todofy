"""Unit tests for the production config generator (host CPython, no Cloudflare access)."""

import json
import re
import stat
import tomllib
from pathlib import Path

import pytest

from deploy.generate_ci_config import FIXED_VARS, MAX_REPORT_TOP, ROOT, SettingError, generate_config, main
from todofy.core.report_schema import MAX_TOP_N

BASE = tomllib.loads((ROOT / "wrangler.toml").read_text())
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
EXPECTED_VARS = {
    "GEMINI_API_BASE",
    "TODOIST_API_BASE",
    "TODOFY_PUBLIC_HOST",
    "TODOFY_HOOKS_HOSTS",
    "BUILD_SHA",
    "MAIL_SOURCE_ID",
    "ACCESS_ISSUER",
    "ACCESS_AUDIENCE",
    "ACCESS_OWNER",
    "ACCESS_OWNER_ALIASES",
    "GEMINI_MODELS",
    "GEMINI_DAILY_TOKEN_BUDGET",
    "TODOIST_DEFAULT_PROJECT_ID",
    "LOOKUP_DELAY_MS",
    "REPORT_DEFAULT_TOP",
    "REPORT_PRECOMPUTE_UTC",
    "LEGACY_TEXT_RETENTION_DAYS",
    "REMINDER_ENABLED",
    "MAINTENANCE_MODE",
    "PROCESSING_PAUSED",
    "FORCE_PAUSE_TODOIST",
}


def generate(**overrides: str) -> dict:
    return generate_config(VALID | overrides, BASE)


def test_worker_shape_is_the_shipped_wrangler_toml() -> None:
    config = generate()
    for key in (
        "name",
        "main",
        "base_dir",
        "compatibility_date",
        "compatibility_flags",
        "assets",
        "durable_objects",
        "migrations",
        "triggers",
    ):
        assert config[key] == BASE[key], key
    assert config["compatibility_date"] == "2026-09-08"
    assert config["compatibility_flags"] == ["python_workers"]
    assert config["triggers"] == {"crons": ["*/10 * * * *"]}
    assert config["assets"]["run_worker_first"] is True
    assert config["workers_dev"] is False and config["preview_urls"] is False
    assert config["observability"] == {"enabled": True}


def test_valid_variables_fill_account_database_routes_and_vars() -> None:
    config = generate()
    assert config["account_id"] == "0" * 32
    assert config["d1_databases"] == [
        {
            "binding": "DB",
            "database_name": "todofy",
            "database_id": "00000000-0000-4000-8000-000000000000",
            "migrations_dir": "migrations",
        }
    ]
    assert config["routes"] == [
        {"pattern": "todofy.example.com", "custom_domain": True},
        {"pattern": "todofy-hooks.example.com", "custom_domain": True},
    ]
    assert set(config["vars"]) == EXPECTED_VARS
    assert all(isinstance(value, str) for value in config["vars"].values())


def test_defaults_apply_when_optional_variables_are_unset_or_empty() -> None:
    expected = {
        "MAIL_SOURCE_ID": "mail-hero-personal",
        "ACCESS_OWNER_ALIASES": "",
        "GEMINI_MODELS": "gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash-lite",
        "GEMINI_DAILY_TOKEN_BUDGET": "3000000",
        "LOOKUP_DELAY_MS": "120000",
        "REPORT_DEFAULT_TOP": "10",
        "REPORT_PRECOMPUTE_UTC": "13:30",
        "LEGACY_TEXT_RETENTION_DAYS": "0",
    }
    for config in (generate(), generate(**dict.fromkeys(OPTIONAL, ""))):
        assert {name: config["vars"][name] for name in expected} == expected
        assert config["d1_databases"][0]["database_name"] == "todofy"


def test_optional_variables_are_passed_through_when_valid() -> None:
    config = generate(
        TODOFY_D1_DATABASE_NAME="todofy-prod",
        TODOFY_ACCESS_OWNER_ALIASES=" alias@example.org , other@example.net ",
        TODOFY_GEMINI_MODELS="gemini-3.7-flash",
        TODOFY_REPORT_DEFAULT_TOP="5",
        TODOFY_REPORT_PRECOMPUTE_UTC="23:59",
        TODOFY_LEGACY_TEXT_RETENTION_DAYS="90",
        TODOFY_MAINTENANCE_MODE="true",
    )
    assert config["d1_databases"][0]["database_name"] == "todofy-prod"
    assert config["vars"]["ACCESS_OWNER_ALIASES"] == "alias@example.org,other@example.net"
    assert config["vars"]["GEMINI_MODELS"] == "gemini-3.7-flash"
    assert config["vars"]["REPORT_DEFAULT_TOP"] == "5"
    assert config["vars"]["REPORT_PRECOMPUTE_UTC"] == "23:59"
    assert config["vars"]["LEGACY_TEXT_RETENTION_DAYS"] == "90"
    assert config["vars"]["MAINTENANCE_MODE"] == "true"


def test_build_sha_is_the_40_hex_commit() -> None:
    build = generate()["vars"]["BUILD_SHA"]
    assert build == SHA and re.fullmatch(r"[0-9a-f]{40}", build)


def test_dev_switches_are_never_emitted() -> None:
    config = generate(DEV_AUTH_BYPASS="true", DEV_ACCESS_LOOPBACK_ISSUER="true", DEV_FAKES="true")
    assert "DEV_" not in json.dumps(config)


def test_every_hooks_host_gets_a_custom_domain_route() -> None:
    config = generate(TODOFY_HOOKS_HOSTS="todofy-hooks.example.com, hooks-b.example.com")
    assert [route["pattern"] for route in config["routes"]] == [
        "todofy.example.com",
        "todofy-hooks.example.com",
        "hooks-b.example.com",
    ]
    assert all(route["custom_domain"] is True for route in config["routes"])
    assert config["vars"]["TODOFY_HOOKS_HOSTS"] == "todofy-hooks.example.com,hooks-b.example.com"


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
            generate_config(env, BASE)


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
    # The local base config and production talk to the same upstreams.
    assert {name: BASE["vars"][name] for name in FIXED_VARS} == FIXED_VARS


def test_main_writes_a_private_file_and_prints_only_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    env = VALID | {"TODOFY_ACCESS_OWNER_ALIASES": "alias@example.org"}
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    output = tmp_path / "wrangler.production.ci.json"
    assert main(output) == 0
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert json.loads(output.read_text()) == generate_config(env, BASE)
    printed = capsys.readouterr()
    assert "ACCESS_OWNER" in printed.out
    for value in env.values():
        assert value not in printed.out + printed.err


def test_main_never_overwrites_an_existing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in VALID.items():
        monkeypatch.setenv(name, value)
    output = tmp_path / "wrangler.production.ci.json"
    output.write_text("local")
    assert main(output) == 1
    assert output.read_text() == "local"
    assert "already exists" in capsys.readouterr().err


def test_main_reports_the_bad_variable_without_its_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in VALID.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("TODOFY_ACCESS_AUDIENCE", "secret-looking-value")
    output = tmp_path / "wrangler.production.ci.json"
    assert main(output) == 1
    assert not output.exists()
    printed = capsys.readouterr()
    assert printed.err.strip() == "Invalid or missing CI setting: TODOFY_ACCESS_AUDIENCE"
    assert "secret-looking-value" not in printed.out + printed.err
