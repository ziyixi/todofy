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
    SECRETS,
    UNSET,
    SettingError,
    generate_secrets,
    injected_vars,
    main,
    refusal,
    secrets_file_problem,
    wrangler_args,
)

SHA = "0123456789abcdef0123456789abcdef01234567"
# Synthetic values only.
VALID = {
    "GITHUB_SHA": SHA,
    "TODOFY_MAINTENANCE_MODE": "false",
    "TODOFY_PROCESSING_PAUSED": "true",
    "TODOFY_ACCESS_OWNER": "owner@example.com",
    "TODOFY_ACCESS_OWNER_ALIASES": "",
}
PERSONAL = ("ACCESS_OWNER", "ACCESS_OWNER_ALIASES")
DEPLOY = ["npx", "--no-install", "wrangler", "deploy"]


@pytest.fixture
def files(tmp_path: Path) -> dict[str, Path]:
    """A valid secrets file per Worker, as `secrets` writes it."""
    found = {}
    for worker in SECRETS:
        found[worker] = tmp_path / f"{worker}-secrets.json"
        assert main(["secrets", worker, str(found[worker])], VALID) == 0
    return found


def test_each_worker_gets_the_build_and_its_switches_as_vars() -> None:
    assert injected_vars("core", VALID) == {"BUILD_SHA": SHA, "MAINTENANCE_MODE": "false", "PROCESSING_PAUSED": "true"}
    assert injected_vars("gateway", VALID) == {"BUILD_SHA": SHA, "MAINTENANCE_MODE": "false"}
    assert wrangler_args("gateway", VALID | {"TODOFY_MAINTENANCE_MODE": "true"}) == [
        "--var",
        f"BUILD_SHA:{SHA}",
        "--var",
        "MAINTENANCE_MODE:true",
    ]


def test_personal_values_are_only_secrets_never_a_var() -> None:
    """Wrangler and the Cloudflare dashboard show a plain var's value; a Worker secret is hidden."""
    for worker in INJECTED:
        names = {item.name for item in INJECTED[worker]}
        sources = {item.source for item in INJECTED[worker]}
        assert not names & set(PERSONAL), worker
        assert not sources & {source for inputs in SECRET_INPUTS.values() for source in inputs}, worker
        assert all(item.kind in ("build", "toggle") for item in INJECTED[worker])
        assert all(item.kind in ("personal", "optional") for item in SECRETS[worker])
        for flag in wrangler_args(worker, VALID):
            personal = [value for key, value in VALID.items() if value and "OWNER" in key]
            assert not [value for value in personal if value in flag]
    # The core's Tasks projects left with the reminder, the weekly review and the mail tasks (2026-10-21).
    assert SECRETS["core"] == ()
    assert [item.name for item in SECRETS["gateway"]] == list(PERSONAL)


def test_the_marker_lists_every_input() -> None:
    # .github/scripts/test_wrangler_configs.py reads these lines to check every CI step's env.
    text = (ROOT / "deploy" / "deploy_vars.py").read_text()
    markers: dict[str, list[str]] = {}
    for mode, names in re.findall(r"^# deploy-vars-inputs (\w+): (.+)$", text, re.MULTILINE):
        markers.setdefault(mode, []).extend(names.split())
    # A mode without inputs has no line: `secrets core` since the core lost its projects.
    assert SECRET_INPUTS["core"] == ()
    assert markers == {
        "core": [item.source for item in INJECTED["core"]],
        "gateway": [item.source for item in INJECTED["gateway"]],
        "secrets_gateway": list(SECRET_INPUTS["gateway"]),
    }


@pytest.mark.parametrize(
    ("name", "value"),
    [
        *[(item.source, None) for item in INJECTED["core"]],
        *[(item.source, "") for item in INJECTED["core"]],
        ("GITHUB_SHA", SHA[:39]),
        ("GITHUB_SHA", SHA.upper()),
        ("TODOFY_MAINTENANCE_MODE", "1"),
        ("TODOFY_MAINTENANCE_MODE", "True"),
        ("TODOFY_PROCESSING_PAUSED", "yes"),
        ("TODOFY_PROCESSING_PAUSED", "false "),
    ],
)
def test_a_missing_or_invalid_var_names_only_the_setting(name: str, value: str | None) -> None:
    env = {key: item for key, item in (VALID | {name: value}).items() if item is not None}
    with pytest.raises(SettingError) as raised:
        wrangler_args("core", env)
    assert str(raised.value) == f"Invalid or missing deploy setting: {name}"


def test_the_core_secrets_are_only_its_map() -> None:
    """No personal value: the file holds what the TODOFY_CORE_WORKER_SECRETS map holds, or nothing."""
    assert generate_secrets("core", VALID) == {}
    mapped = VALID | {"TODOFY_CORE_WORKER_SECRETS": json.dumps({"TODOIST_API_KEY": "synthetic-key"})}
    assert generate_secrets("core", mapped) == {"TODOIST_API_KEY": "synthetic-key"}


@pytest.mark.parametrize("retired", ["synthetic-private-provider-key", "", 7])
def test_old_core_gemini_map_field_is_dropped_before_validation(retired: object, tmp_path: Path) -> None:
    env = VALID | {"TODOFY_CORE_WORKER_SECRETS": json.dumps({"GEMINI_API_KEY": retired})}
    assert generate_secrets("core", env) == {}
    path = tmp_path / "retired.json"
    assert main(["secrets", "core", str(path)], env) == 0
    assert json.loads(path.read_text()) == {}
    assert secrets_file_problem("core", path) is None


@pytest.mark.parametrize("worker,field,name", [
    ("core", "TODOFY_CORE_WORKER_SECRETS", "ANTHROPIC_API_KEY"),
    ("core", "TODOFY_CORE_WORKER_SECRETS", "GEMINI_API_KEY_EXTRA"),
    ("gateway", "TODOFY_WORKER_SECRETS", "GEMINI_API_KEY"),
])
def test_provider_keys_cannot_enter_another_todofy_github_map(worker: str, field: str, name: str) -> None:
    with pytest.raises(SettingError, match=field):
        generate_secrets(worker, VALID | {field: json.dumps({name: "synthetic-private-provider-key"})})


def test_the_gateway_secrets_are_the_owner_and_the_aliases() -> None:
    """An empty alias list is uploaded as one space, which the gateway trims to none: leaving it out of
    --secrets-file would keep a previous alias working."""
    assert UNSET == " "
    assert generate_secrets("gateway", VALID) == {"ACCESS_OWNER": "owner@example.com", "ACCESS_OWNER_ALIASES": UNSET}
    aliases = VALID | {"TODOFY_ACCESS_OWNER_ALIASES": " alias@example.org , other@example.net "}
    assert generate_secrets("gateway", aliases) == {
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
        ("TODOFY_ACCESS_OWNER", "\u212aate@example.com"),  # a Kelvin sign, not ASCII K
        ("TODOFY_ACCESS_OWNER_ALIASES", None),
        ("TODOFY_ACCESS_OWNER_ALIASES", "not-an-email"),
        ("TODOFY_ACCESS_OWNER_ALIASES", "a@example.org,a@example.org"),
        ("TODOFY_ACCESS_OWNER_ALIASES", "alias@example.org,\u212aim@example.net"),
        ("TODOFY_ACCESS_OWNER_ALIASES", ",".join(f"a{index}@example.com" for index in range(9))),
        ("TODOFY_ACCESS_OWNER_ALIASES", ",".join(f"{'a' * 300}{index}@example.com" for index in range(8))),
    ],
)
def test_bad_gateway_secrets_name_only_the_setting(name: str, value: str | None) -> None:
    env = {key: item for key, item in (VALID | {name: value}).items() if item is not None}
    with pytest.raises(SettingError, match=rf"^Invalid or missing deploy setting: {name}$"):
        generate_secrets("gateway", env)


def test_only_a_deploy_of_the_right_config_with_its_secrets_file_may_run(files: dict[str, Path]) -> None:
    core, gateway = f"--secrets-file={files['core']}", ["--secrets-file", str(files["gateway"])]
    assert refusal("core", ["uv", "run", "pywrangler", "deploy", "--config", "wrangler.toml", core], ROOT) is None
    assert refusal("gateway", [*DEPLOY, "--dry-run", "--config=gateway/wrangler.toml", *gateway], ROOT) is None
    assert refusal("gateway", [*DEPLOY, "-c", "wrangler.toml", *gateway], ROOT / "gateway") is None
    for worker, command in [
        ("core", []),
        ("core", [*DEPLOY, core]),
        ("core", [*DEPLOY, "--config", "gateway/wrangler.toml", core]),
        ("gateway", [*DEPLOY, "--config", "wrangler.toml", *gateway]),
        ("core", [*DEPLOY, "--config", "wrangler.test.toml", core]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", core, "--env", "production"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", core, "--env=production"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", core, "-e", "production"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", core, "--keep-vars"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", core, "--var", "BUILD_SHA:x"]),
        ("core", ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.toml"]),
        # The secrets file: exactly one, of this Worker.
        ("core", [*DEPLOY, "--config", "wrangler.toml"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", "--secrets-file"]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", core, core]),
        ("core", [*DEPLOY, "--config", "wrangler.toml", *gateway]),
        ("gateway", [*DEPLOY, "--config", "gateway/wrangler.toml"]),
        ("gateway", [*DEPLOY, "--config", "gateway/wrangler.toml", core]),
    ]:
        assert refusal(worker, command, ROOT) is not None, (worker, command)
    assert set(CONFIGS) == set(INJECTED) == set(SECRETS)


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        "[]",
        {"UNDECLARED": "synthetic-key"},
        {"GEMINI_API_KEY": ""},
        {"GEMINI_API_KEY": 6},
        {"GEMINI_API_KEY": "synthetic-key", "X": "synthetic-key"},
    ],
)
def test_an_invalid_core_secrets_file_is_refused_without_its_values(tmp_path: Path, content: object) -> None:
    path = tmp_path / "core.json"
    path.write_text(content if isinstance(content, str) else json.dumps(content))
    problem = secrets_file_problem("core", path)
    assert problem is not None
    assert "synthetic-key" not in problem


def test_an_invalid_gateway_secrets_file_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "gateway.json"
    for content in (
        {"ACCESS_OWNER": "owner@example.com"},
        {"ACCESS_OWNER": "owner@example.com", "ACCESS_OWNER_ALIASES": ""},
        {"ACCESS_OWNER": " ", "ACCESS_OWNER_ALIASES": " "},
        {"ACCESS_OWNER": "owner@example.com", "ACCESS_OWNER_ALIASES": "a@example.org, b@example.org"},
    ):
        path.write_text(json.dumps(content))
        assert secrets_file_problem("gateway", path) is not None, content
    path.write_text(json.dumps({"ACCESS_OWNER": "owner@example.com", "ACCESS_OWNER_ALIASES": "a@example.org"}))
    assert secrets_file_problem("gateway", path) is None
    assert secrets_file_problem("gateway", tmp_path / "missing.json") is not None


def test_exec_runs_the_command_unchanged_plus_the_vars(
    tmp_path: Path, files: dict[str, Path], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(ROOT)
    capsys.readouterr()
    out = tmp_path / "argv.json"
    script = f"import json,sys; open({str(out)!r}, 'w').write(json.dumps(sys.argv[1:])); sys.exit(3)"
    stub = [sys.executable, "-c", script]
    command = [*stub, "deploy", "--config", "wrangler.toml", "--secrets-file", str(files["core"])]
    env = VALID | {"TODOFY_CORE_WORKER_SECRETS": json.dumps({"TODOIST_API_KEY": "synthetic-key"})}
    assert main(["exec", "core", "--", *command], env) == 3
    sent = json.loads(out.read_text())
    assert sent == [*command[3:], *wrangler_args("core", env)]
    # Secrets travel only in the secrets file, never on the command line (pywrangler echoes it).
    assert not [arg for arg in sent if "synthetic-key" in arg]
    printed = capsys.readouterr()
    assert "synthetic-key" not in printed.out + printed.err
    assert "PROCESSING_PAUSED" in printed.out and "--secrets-file" in printed.out

    out.unlink()
    assert main(["exec", "gateway", "--", *command], VALID) == 2  # the core's config for the gateway
    assert main(["exec", "core", "--", *command[:-2]], VALID) == 2  # no secrets file
    assert main(["exec", "core", "--", *command], VALID | {"TODOFY_PROCESSING_PAUSED": "secret-looking"}) == 1
    assert not out.exists()
    printed = capsys.readouterr()
    assert "Invalid or missing deploy setting: TODOFY_PROCESSING_PAUSED" in printed.err
    assert "exactly one --secrets-file" in printed.err
    assert "secret-looking" not in printed.out + printed.err


def test_exec_does_not_need_the_personal_values(files: dict[str, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the step that writes the secrets files reads the personal secrets."""
    monkeypatch.chdir(ROOT)
    personal = {source for inputs in SECRET_INPUTS.values() for source in inputs}
    switches = {key: value for key, value in VALID.items() if key not in personal}
    stub = [sys.executable, "-c", "import sys; sys.exit(0)"]
    core = [*stub, "deploy", "-c", "wrangler.toml", "--secrets-file", str(files["core"])]
    assert main(["exec", "core", "--", *core], switches) == 0
    gateway = [*stub, "deploy", "-c", "gateway/wrangler.toml", "--secrets-file", str(files["gateway"])]
    assert main(["exec", "gateway", "--", *gateway], switches) == 0


def test_secrets_are_written_private_and_never_over_a_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "secrets.json"
    env = VALID | {"TODOFY_ACCESS_OWNER_ALIASES": "alias@example.org"}
    assert main(["secrets", "gateway", str(path)], env) == 0
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {
        "ACCESS_OWNER": "owner@example.com",
        "ACCESS_OWNER_ALIASES": "alias@example.org",
    }
    core = tmp_path / "core.json"
    assert main(["secrets", "core", str(core)], env) == 0
    assert stat.S_IMODE(core.stat().st_mode) == 0o600
    assert json.loads(core.read_text()) == {}
    path.write_text("local")
    assert main(["secrets", "gateway", str(path)], env) == 1
    assert path.read_text() == "local"
    assert main(["secrets", "core", str(tmp_path / "bad.json")], env | {"TODOFY_CORE_WORKER_SECRETS": "[]"}) == 1
    assert not (tmp_path / "bad.json").exists()
    printed = capsys.readouterr()
    assert "already exists" in printed.err
    assert "Wrote the core secrets file: no secret" in printed.out
    for value in ("owner@example.com", "alias@example.org"):
        assert value not in printed.out + printed.err


def test_check_validates_everything_and_usage_is_refused(tmp_path: Path) -> None:
    assert main(["check"], VALID) == 0
    assert main(["check"], VALID | {"TODOFY_ACCESS_OWNER": ""}) == 1
    assert main(["check"], VALID | {"TODOFY_PROCESSING_PAUSED": ""}) == 1
    assert main([], VALID) == 2
    assert main(["exec", "web", "--", *DEPLOY], VALID) == 2
    assert main(["secrets", str(tmp_path / "x.json")], VALID) == 2  # the Worker must be named
    assert main(["secrets", "web", str(tmp_path / "x.json")], VALID) == 2
    assert not (tmp_path / "x.json").exists()


@pytest.mark.parametrize("worker", ["core", "gateway"])
def test_repair_build_identity_uses_the_validated_source_sha(worker: str) -> None:
    assert injected_vars(worker, VALID | {"BUILD_SOURCE_SHA": "a" * 40})["BUILD_SHA"] == "a" * 40
    assert injected_vars(worker, VALID | {"BUILD_SOURCE_SHA": ""})["BUILD_SHA"] == SHA
    for value in ("main", "A" * 40, "a" * 39, "a" * 40 + "\n"):
        with pytest.raises(SettingError, match="BUILD_SOURCE_SHA"):
            injected_vars(worker, VALID | {"BUILD_SOURCE_SHA": value})


@pytest.mark.parametrize(
    "worker,map_name", [("core", "TODOFY_CORE_WORKER_SECRETS"), ("gateway", "TODOFY_WORKER_SECRETS")]
)
def test_complete_worker_secrets_overlay_personal_fields_without_logging_values(
    worker: str, map_name: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    from deploy.deploy_vars import SECRET_SPECS, WORKER_NAMES

    private = "synthetic-private-value"
    names = SECRET_SPECS[WORKER_NAMES[worker]]["required"]
    complete = dict.fromkeys(names, private)
    env = VALID | {map_name: json.dumps(complete), "REQUIRE_COMPLETE_WORKER_SECRETS": "true"}
    actual = generate_secrets(worker, env)
    for name, value in generate_secrets(worker, VALID).items():
        assert actual[name] == value
    path = tmp_path / "complete.json"
    assert main(["secrets", worker, str(path)], env) == 0
    assert secrets_file_problem(worker, path) is None
    assert private not in capsys.readouterr().out
    invalid = ["not json", "[]", "null", json.dumps({"UNKNOWN": private})]
    if names:
        invalid += ["{}", json.dumps({names[0]: 7})]
    else:
        assert generate_secrets(worker, VALID | {map_name: "{}"}) == {}
    for value in invalid:
        with pytest.raises(SettingError, match=map_name) as caught:
            generate_secrets(worker, VALID | {map_name: value})
        assert private not in str(caught.value)
    with pytest.raises(SettingError, match=map_name):
        generate_secrets(worker, VALID | {"REQUIRE_COMPLETE_WORKER_SECRETS": "true"})
