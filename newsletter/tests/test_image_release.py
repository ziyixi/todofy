"""Image-publication boundaries using fake Docker and synthetic files."""

import importlib.util as util
import json
import os
import pathlib
import subprocess
import types
import unittest.mock as mock

import pytest

import tests.support.workflows as workflows

ROOT = pathlib.Path(__file__).absolute().parents[1]
IMAGE_ID = "sha256:" + "a" * 64
HEALTHCHECK = json.loads((ROOT / "container-healthcheck.json").read_text())


@pytest.fixture
def smoke():
    spec = util.spec_from_file_location(
        "offline_image_smoke", ROOT / "scripts/smoke_image.py"
    )
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def probe():
    spec = util.spec_from_file_location(
        "offline_image_probe", ROOT / "scripts/smoke_image_probe.py"
    )
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("generated_kind", ["missing", "file", "directory"])
def test_probe_uses_traversable_interface_for_absent_generated_package(
    probe, monkeypatch, generated_kind
):
    class Resource:
        # Traversable has no exists(), even when backed by a real directory.
        def is_file(self):
            return generated_kind == "file"

        def is_dir(self):
            return generated_kind == "directory"

    class Package:
        def __str__(self):
            return "/installed/site-packages/newsletter"

        def joinpath(self, relative):
            assert relative == "generated"
            return Resource()

    monkeypatch.setattr(
        probe, "resources", types.SimpleNamespace(files=lambda _: Package())
    )
    monkeypatch.setattr(
        probe,
        "os",
        types.SimpleNamespace(
            getuid=lambda: 10001,
            getgid=lambda: 10001,
            ST_RDONLY=os.ST_RDONLY,
            statvfs=lambda _: types.SimpleNamespace(f_flag=os.ST_RDONLY),
        ),
    )
    monkeypatch.setattr(
        probe,
        "pathlib",
        types.SimpleNamespace(
            Path=lambda _: types.SimpleNamespace(
                read_text=lambda: "routing table header\n", exists=lambda: False
            )
        ),
    )
    monkeypatch.setattr(
        probe, "socket", types.SimpleNamespace(if_nameindex=lambda: [(1, "lo")])
    )
    monkeypatch.setattr(
        probe, "util", types.SimpleNamespace(find_spec=lambda _: None)
    )
    monkeypatch.setattr(
        probe, "shutil", types.SimpleNamespace(which=lambda _: None)
    )
    checked = mock.Mock()
    monkeypatch.setattr(
        probe,
        "preflight",
        types.SimpleNamespace(check_proto_dependency=checked),
    )
    if generated_kind == "missing":
        probe.check_package({})
        checked.assert_called_once_with()
    else:
        with pytest.raises(AssertionError, match="generated package contents"):
            probe.check_package({})
        checked.assert_not_called()


@pytest.fixture
def source_root(tmp_path):
    root = tmp_path / "newsletter"
    package = root / "src/newsletter"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text('"""Synthetic source."""\n')
    scripts = root / "scripts"
    scripts.mkdir()
    (scripts / "smoke_codex_startup.py").write_text(
        "# Synthetic startup fixture\n"
    )
    (scripts / "smoke_image_probe.py").write_text(
        "# Synthetic container fixture\n"
    )
    # The repository's public identities: the console AUD the image bakes.
    (tmp_path / "config").mkdir()
    (tmp_path / "config/resources.toml").write_text(
        'version = 1\n[access_audiences]\n"newsletter-console" = "'
        + "c" * 64
        + '"\n'
    )
    (root / "container-healthcheck.json").write_text(json.dumps(HEALTHCHECK))
    (tmp_path / ".python-version").write_text("3.14.7\n")
    return root


@pytest.fixture
def docker(smoke, monkeypatch):
    state = types.SimpleNamespace(
        calls=[],
        failure=None,
        metadata={
            "id": IMAGE_ID,
            "os": "linux",
            "architecture": "amd64",
            "user": "newsletter",
            "healthcheck": HEALTHCHECK,
        },
    )

    def run(command, **kwargs):
        state.calls.append((command, kwargs))
        if command[1:3] == ["image", "inspect"]:
            return types.SimpleNamespace(stdout=json.dumps(state.metadata))
        if command[1] == "run" and state.failure:
            raise state.failure
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(smoke.subprocess, "run", run)
    return state


def test_smoke_uses_fixed_inspected_id_without_mounts_network_or_credentials(
    smoke, source_root, docker
):
    assert (
        smoke.verify("mutable:tag", "linux/amd64", root=source_root) == IMAGE_ID
    )
    inspect, run, cleanup = docker.calls
    assert inspect[0][-2:] == ["--", "mutable:tag"]
    command, options = run
    for option, value in (
        ("--platform", "linux/amd64"),
        ("--network", "none"),
        ("--pull", "never"),
        ("--user", "10001:10001"),
        ("--cap-drop", "ALL"),
        ("--security-opt", "no-new-privileges:true"),
    ):
        assert command[command.index(option) + 1] == value
    assert "--read-only" in command and "--rm" in command
    assert not {"--mount", "--volume", "-v", "--env", "--env-file", "-e"} & set(
        command
    )
    assert IMAGE_ID in command and "mutable:tag" not in command
    assert options["timeout"] == 120 and options["check"] is True
    payload = json.loads(options["input"])
    assert set(payload) == {
        "source_hashes",
        "startup_source",
        "console_audience",
        "python_version",
    }
    assert payload["console_audience"] == "c" * 64
    name = command[command.index("--name") + 1]
    assert name.startswith("newsletter-image-smoke-")
    assert cleanup[0] == ["docker", "rm", "--force", name]
    assert cleanup[1]["timeout"] == 15
    assert all(
        call[0][1] not in {"build", "pull", "push", "login"}
        for call in docker.calls
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("architecture", "arm64"),
        ("os", "windows"),
        ("id", "mutable:tag"),
        ("user", ""),
        ("user", "root"),
        ("user", "0:0"),
        ("healthcheck", None),
    ],
)
def test_wrong_image_metadata_is_rejected_before_container_start(
    smoke, source_root, docker, field, value
):
    docker.metadata[field] = value
    with pytest.raises(
        ValueError,
        match=(
            r"fixed image ID|architecture does not match|nonroot user"
            r"|HTTP HEALTHCHECK"
        ),
    ):
        smoke.verify("fixture", "linux/amd64", root=source_root)
    assert len(docker.calls) == 1


@pytest.mark.parametrize(
    "failure",
    [
        subprocess.TimeoutExpired("docker", 120),
        subprocess.CalledProcessError(1, "docker"),
    ],
)
def test_failed_probe_still_removes_only_its_unique_container(
    smoke, source_root, docker, failure
):
    docker.failure = failure
    with pytest.raises(type(failure)):
        smoke.verify("fixture", "linux/amd64", root=source_root)
    name = docker.calls[1][0][docker.calls[1][0].index("--name") + 1]
    assert docker.calls[-1][0] == ["docker", "rm", "--force", name]


@pytest.mark.parametrize(
    "name",
    [
        ".env.production",
        "auth.json",
        "AUTH.JSON",
        "credentials.json",
        "account.key",
        "history.sqlite3",
        "preview.eml",
    ],
)
def test_source_audit_rejects_private_names_without_reading_contents(
    smoke, source_root, name, monkeypatch
):
    path = source_root / "src/newsletter" / name
    path.write_text("Synthetic; contents must never be inspected")
    original = pathlib.Path.read_bytes

    def read_bytes(candidate):
        assert candidate != path
        return original(candidate)

    monkeypatch.setattr(pathlib.Path, "read_bytes", read_bytes)
    with pytest.raises(ValueError, match="private-file"):
        smoke.source_hashes(source_root)


def test_source_audit_rejects_symlinks(smoke, source_root):
    package = source_root / "src/newsletter"
    (package / "alias.py").symlink_to(package / "__init__.py")
    with pytest.raises(ValueError, match="symlinks"):
        smoke.source_hashes(source_root)


def test_source_audit_hashes_package_inputs_but_ignores_bytecode(
    smoke, source_root
):
    package = source_root / "src/newsletter"
    (package / "fixture.json").write_text('{"synthetic":true}')
    (package / "__pycache__").mkdir()
    (package / "__pycache__/cache.pyc").write_bytes(b"synthetic")
    assert set(smoke.source_hashes(source_root)) == {
        "__init__.py",
        "fixture.json",
    }


def test_ci_smokes_native_amd64_before_publish_without_rebuild():
    jobs = workflows.load("ci.yml")["jobs"]
    image = jobs["artifacts"]
    assert image["runs-on"] == "ubuntu-24.04"
    assert image["needs"] == "changes"
    assert "artifact_matrix" in image["strategy"]["matrix"]
    commands = "\n".join(step.get("run", "") for step in image["steps"])
    builder = "container-release/build.py --service newsletter"
    assert commands.count(builder) == 1
    assert "docker build" not in commands
    assert "--platform linux/amd64" in commands
    assert commands.index("--audit-source") < commands.index(builder)
    assert commands.index(builder) < commands.index("smoke_image.py --image")
    assert commands.index("smoke_image.py --image") < commands.index(
        "image.py save"
    )
    publication = jobs["newsletter-deploy"]
    assert "gate" in publication["needs"]
    assert "needs.gate.result == 'success'" in publication["if"]
    assert "github.ref == 'refs/heads/main'" in publication["if"]
    steps = publication["steps"]
    login = next(
        index
        for index, step in enumerate(steps)
        if "docker login" in step.get("run", "")
    )
    publish = next(
        index
        for index, step in enumerate(steps)
        if "image.py publish" in step.get("run", "")
    )
    assert login < publish
    assert all("docker build" not in step.get("run", "") for step in steps)
    assert publication["permissions"]["packages"] == "write"


def test_daily_workflow_never_schedules_or_sends():
    workflow = workflows.load("newsletter-daily.yml")
    assert set(workflow["on"]) == {"workflow_dispatch", "repository_dispatch"}
    steps = workflow["jobs"]["prepare"]["steps"]
    trigger = next(step for step in steps if "run" in step)
    assert trigger["run"] == "python3 newsletter/scripts/trigger_run.py"
    assert "NEWSLETTER_EDITOR_TOKEN" in trigger["env"]
    assert all(
        not {"NEWSLETTER_SEND_TOKEN", "RESEND_API_KEY"}
        & step.get("env", {}).keys()
        and "latest send" not in step.get("run", "")
        and "/send" not in step.get("run", "")
        for step in steps
    )


def test_git_ignore_protects_variants_but_keeps_blank_templates(tmp_path):
    (tmp_path / ".gitignore").write_bytes((ROOT / ".gitignore").read_bytes())
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    ignored = [
        ".env",
        ".env.local",
        ".env.production",
        ".env.backup",
        "auth.json",
        "credentials.json",
        "nested/.env.live",
        "nested/auth.json",
        "account.key",
        "history.sqlite3",
        "preview.eml",
    ]
    allowed = [".env.example", ".env.production.example", "nested/.env.example"]
    result = subprocess.run(
        ["git", "check-ignore", "--no-index", "--stdin"],
        cwd=tmp_path,
        input="\n".join(ignored + allowed) + "\n",
        text=True,
        capture_output=True,
        check=True,
        env={
            "PATH": os.defpath,
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        },
        timeout=10,
    )
    assert set(result.stdout.splitlines()) == set(ignored)
