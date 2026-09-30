"""Unit tests for the deploy-time values wrapper (host CPython, no Cloudflare access)."""

import json
import re
import stat
import sys
from pathlib import Path

import pytest

from deploy.deploy_vars import (
    CONFIGS,
    INJECTED,
    ROOT,
    SECRET_INPUTS,
    SettingError,
    generate_secrets,
    injected_vars,
    main,
    refusal,
    wrangler_args,
)

SHA = "0123456789abcdef0123456789abcdef01234567"
# Synthetic values only.
VALID = {
    "GITHUB_SHA": SHA,
    "TODOFY_MAINTENANCE_MODE": "false",
    "TODOFY_TODOIST_DEFAULT_PROJECT_ID": "6Jf8VQXxpwv56VQ7",
    "TODOFY_REMINDER_ENABLED": "true",
    "TODOFY_PROCESSING_PAUSED": "false",
    "TODOFY_FORCE_PAUSE_TODOIST": "false",
    "TODOFY_GTD_REVIEW_ENABLED": "false",
    "TODOFY_TODOIST_OPS_PROJECT_ID": "",
    "TODOFY_TODOIST_REVIEW_PROJECT_ID": "",
    "TODOFY_ACCESS_OWNER": "owner@example.com",
    "TODOFY_ACCESS_OWNER_ALIASES": "",
}
DEPLOY = ["npx", "--no-install", "wrangler", "deploy"]


def test_each_worker_gets_the_build_its_switches_and_the_core_its_project() -> None:
    assert injected_vars("core", VALID) == {
        "BUILD_SHA": SHA,
        "MAINTENANCE_MODE": "false",
        "TODOIST_DEFAULT_PROJECT_ID": "6Jf8VQXxpwv56VQ7",
        "REMINDER_ENABLED": "true",
        "PROCESSING_PAUSED": "false",
        "FORCE_PAUSE_TODOIST": "false",
        "GTD_REVIEW_ENABLED": "false",
    }
    assert injected_vars("gateway", VALID) == {"BUILD_SHA": SHA, "MAINTENANCE_MODE": "false"}
    assert wrangler_args("gateway", VALID | {"TODOFY_MAINTENANCE_MODE": "true"}) == [
        "--var",
        f"BUILD_SHA:{SHA}",
        "--var",
        "MAINTENANCE_MODE:true",
    ]


def test_the_marker_lists_every_input() -> None:
    # .github/scripts/test_wrangler_configs.py reads these lines to check every CI step's env.
    text = (ROOT / "deploy" / "deploy_vars.py").read_text()
    markers: dict[str, list[str]] = {}
    for mode, names in re.findall(r"^# deploy-vars-inputs (\w+): (.+)$", text, re.MULTILINE):
        markers.setdefault(mode, []).extend(names.split())
    assert markers == {
        "core": [item.source for item in INJECTED["core"]],
        "gateway": [item.source for item in INJECTED["gateway"]],
        "secrets": list(SECRET_INPUTS),
    }


@pytest.mark.parametrize(
    ("name", "value"),
    [
        *[(item.source, None) for item in INJECTED["core"] if item.kind != "optional"],
        *[(item.source, "") for item in INJECTED["core"] if item.kind != "optional"],
        ("TODOFY_GTD_REVIEW_ENABLED", "on"),
        ("TODOFY_TODOIST_OPS_PROJECT_ID", "ops project"),
        ("TODOFY_TODOIST_REVIEW_PROJECT_ID", "r" * 65),
        ("GITHUB_SHA", SHA[:39]),
        ("GITHUB_SHA", SHA.upper()),
        ("TODOFY_MAINTENANCE_MODE", "1"),
        ("TODOFY_REMINDER_ENABLED", "True"),
        ("TODOFY_PROCESSING_PAUSED", "yes"),
        ("TODOFY_FORCE_PAUSE_TODOIST", "false "),
        ("TODOFY_TODOIST_DEFAULT_PROJECT_ID", "inbox project"),
        ("TODOFY_TODOIST_DEFAULT_PROJECT_ID", "p" * 65),
    ],
)
def test_a_missing_or_invalid_value_names_only_the_setting(name: str, value: str | None) -> None:
    env = {key: item for key, item in (VALID | {name: value}).items() if item is not None}
    with pytest.raises(SettingError) as raised:
        wrangler_args("core", env)
    assert str(raised.value) == f"Invalid or missing deploy setting: {name}"


@pytest.mark.parametrize("unset", [None, ""])
def test_optional_projects_are_sent_only_when_set(unset: str | None) -> None:
    """An unset optional project adds no --var, so the deploy leaves it unset (the default project)."""
    env = {key: value for key, value in VALID.items() if not key.endswith(("_OPS_PROJECT_ID", "_REVIEW_PROJECT_ID"))}
    if unset is not None:
        env |= {"TODOFY_TODOIST_OPS_PROJECT_ID": unset, "TODOFY_TODOIST_REVIEW_PROJECT_ID": unset}
    names = set(injected_vars("core", env))
    assert "TODOIST_OPS_PROJECT_ID" not in names and "TODOIST_REVIEW_PROJECT_ID" not in names
    both = env | {"TODOFY_TODOIST_OPS_PROJECT_ID": "6OpsProj", "TODOFY_TODOIST_REVIEW_PROJECT_ID": "6Review_1"}
    assert injected_vars("core", both) | {} == injected_vars("core", env) | {
        "TODOIST_OPS_PROJECT_ID": "6OpsProj",
        "TODOIST_REVIEW_PROJECT_ID": "6Review_1",
    }
    assert wrangler_args("core", both)[-4:] == [
        "--var",
        "TODOIST_OPS_PROJECT_ID:6OpsProj",
        "--var",
        "TODOIST_REVIEW_PROJECT_ID:6Review_1",
    ]


def test_the_secrets_are_the_owner_and_the_aliases() -> None:
    assert generate_secrets(VALID) == {"ACCESS_OWNER": "owner@example.com", "ACCESS_OWNER_ALIASES": " "}
    assert generate_secrets(VALID | {"TODOFY_ACCESS_OWNER_ALIASES": " alias@example.org , other@example.net "}) == {
        "ACCESS_OWNER": "owner@example.com",
        "ACCESS_OWNER_ALIASES": "alias@example.org,other@example.net",
    }


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("TODOFY_ACCESS_OWNER", None),
        ("TODOFY_ACCESS_OWNER", ""),
        ("TODOFY_ACCESS_OWNER", "owner"),
        ("TODOFY_ACCESS_OWNER", "owner@example.com "),
        ("TODOFY_ACCESS_OWNER", "Kate@example.com"),
        ("TODOFY_ACCESS_OWNER_ALIASES", None),
        ("TODOFY_ACCESS_OWNER_ALIASES", "not-an-email"),
        ("TODOFY_ACCESS_OWNER_ALIASES", "a@example.org,a@example.org"),
        ("TODOFY_ACCESS_OWNER_ALIASES", "alias@example.org,Kim@example.net"),
        ("TODOFY_ACCESS_OWNER_ALIASES", ",".join(f"a{index}@example.com" for index in range(9))),
        ("TODOFY_ACCESS_OWNER_ALIASES", ",".join(f"{'a' * 300}{index}@example.com" for index in range(8))),
    ],
)
def test_bad_secrets_name_only_the_setting(name: str, value: str | None) -> None:
    env = {key: item for key, item in (VALID | {name: value}).items() if item is not None}
    with pytest.raises(SettingError, match=rf"^Invalid or missing deploy setting: {name}$"):
        generate_secrets(env)


def test_only_a_deploy_of_the_right_config_may_run() -> None:
    assert refusal("core", ["uv", "run", "pywrangler", "deploy", "--config", "wrangler.toml"], ROOT) is None
    assert refusal("gateway", [*DEPLOY, "--dry-run", "--config=gateway/wrangler.toml"], ROOT) is None
    assert refusal("gateway", [*DEPLOY, "-c", "wrangler.toml"], ROOT / "gateway") is None
    for worker, command in [
        ("core", []),
        ("core", DEPLOY),
        ("core", [*DEPLOY, "--config", "gateway/wrangler.toml"]),
        ("gateway", [*DEPLOY, "--config", "wrangler.toml"]),
        ("core", [*DEPLOY, "--config", "wrangler.test.toml"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", "--env", "production"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", "--env=production"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", "-e", "production"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", "--keep-vars"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", "--var", "BUILD_SHA:x"]),
        ("core", ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.toml"]),
    ]:
        assert refusal(worker, command, ROOT) is not None, (worker, command)
    assert set(CONFIGS) == set(INJECTED)


def test_exec_runs_the_command_unchanged_plus_the_vars(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(ROOT)
    out = tmp_path / "argv.json"
    script = f"import json,sys; open({str(out)!r}, 'w').write(json.dumps(sys.argv[1:])); sys.exit(3)"
    stub = [sys.executable, "-c", script]
    command = [*stub, "deploy", "--config", "wrangler.toml"]
    assert main(["exec", "core", "--", *command], VALID) == 3
    assert json.loads(out.read_text()) == ["deploy", "--config", "wrangler.toml", *wrangler_args("core", VALID)]
    printed = capsys.readouterr()
    for value in VALID.values():
        if value:
            assert value not in printed.out + printed.err

    out.unlink()
    assert main(["exec", "gateway", "--", *command], VALID) == 2  # the core's config for the gateway
    assert main(["exec", "core", "--", *command], VALID | {"TODOFY_PROCESSING_PAUSED": "secret-looking"}) == 1
    assert not out.exists()
    printed = capsys.readouterr()
    assert "Invalid or missing deploy setting: TODOFY_PROCESSING_PAUSED" in printed.err
    assert "secret-looking" not in printed.out + printed.err


def test_secrets_are_written_private_and_never_over_a_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "secrets.json"
    env = VALID | {"TODOFY_ACCESS_OWNER_ALIASES": "alias@example.org"}
    assert main(["secrets", str(path)], env) == 0
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {
        "ACCESS_OWNER": "owner@example.com",
        "ACCESS_OWNER_ALIASES": "alias@example.org",
    }
    path.write_text("local")
    assert main(["secrets", str(path)], env) == 1
    assert path.read_text() == "local"
    printed = capsys.readouterr()
    assert "already exists" in printed.err
    assert "owner@example.com" not in printed.out + printed.err


def test_check_validates_everything_and_usage_is_refused() -> None:
    assert main(["check"], VALID) == 0
    assert main(["check"], VALID | {"TODOFY_ACCESS_OWNER": ""}) == 1
    assert main([], VALID) == 2
    assert main(["exec", "web", "--", *DEPLOY], VALID) == 2
