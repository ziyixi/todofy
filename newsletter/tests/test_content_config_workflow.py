"""Offline publication tests using synthetic API and Docker responses."""

from __future__ import annotations

import base64
import hashlib
import importlib.util as util
import io
import json
import os
import pathlib
import subprocess
import types
import unittest.mock as mock
import urllib.error as urllib_error

import pytest

import tests.support.workflows as workflows

ROOT = pathlib.Path(__file__).resolve().parents[1]
OLD = "a" * 40
NEW = "b" * 40
PR = "c" * 40
PARENT = "d" * 40
BLOB = "e" * 40
TREE = "f" * 40
COMMIT = "1" * 40
IMAGE = "sha256:" + "2" * 64
SECRET = "synthetic-private-token-never-print"


@pytest.fixture
def release():
    spec = util.spec_from_file_location(
        "offline_content_release", ROOT / "scripts/publish_content_config.py"
    )
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_record(engine: str, **overrides) -> dict:
    return {
        "head_sha": engine,
        "id": int(engine[:8], 16),
        "conclusion": "success",
        "event": "push",
        "head_branch": "main",
        **overrides,
    }


def api_fixture(
    *,
    current: str = NEW,
    runs: list | None = None,
    differences: dict | None = None,
):
    calls = []
    differences = differences or {}

    def request(method, path, value=None, **kwargs):
        calls.append((method, path, value, kwargs))
        if path.startswith("/actions/workflows/ci.yml/runs?"):
            return {
                "workflow_runs": runs if runs is not None else [run_record(OLD)]
            }
        if path.startswith("/actions/runs/"):
            return {
                "jobs": [
                    {
                        "name": "Newsletter image publish",
                        "conclusion": "success",
                    }
                ]
            }
        if path.startswith("/compare/"):
            return differences.get(
                path,
                {
                    "status": "ahead",
                    "files": [
                        {"filename": "newsletter/content-config/editorial.yaml"}
                    ],
                },
            )
        raise AssertionError("unexpected API request")

    return types.SimpleNamespace(
        main=mock.Mock(return_value=current),
        request=mock.Mock(side_effect=request),
        calls=calls,
    )


@pytest.mark.parametrize(
    "event_name,event",
    [
        ("push", {"ref": "refs/heads/main", "after": NEW}),
        ("workflow_dispatch", {}),
        ("workflow_run", {"workflow_run": run_record(OLD)}),
    ],
)
def test_config_only_publication_reuses_successful_ancestor_engine(
    release, event_name, event
):
    api = api_fixture()
    assert release.plan(api, event_name, event) == {
        "ready": "true",
        "revision": NEW,
        "engine_sha": OLD,
    }
    assert all(method == "GET" for method, *_ in api.calls)


def test_diverged_configuration_pr_can_validate_without_building_candidate_code(
    release,
):
    api = api_fixture(
        differences={
            f"/compare/{NEW}...{PR}": {
                "status": "diverged",
                "files": [
                    {
                        "filename": (
                            "newsletter/content-config/policy/editorial.md"
                        )
                    }
                ],
            }
        }
    )
    event = {"pull_request": {"head": {"sha": PR}, "base": {"sha": NEW}}}
    assert release.plan(api, "pull_request", event) == {
        "ready": "true",
        "revision": PR,
        "engine_sha": OLD,
    }


@pytest.mark.parametrize(
    "file",
    [
        {"filename": "newsletter/src/newsletter/service.py"},
        {
            "filename": "newsletter/content-config/copied.py",
            "previous_filename": "scripts/program.py",
        },
        {
            "filename": "newsletter/content-config/anything",
            "previous_filename": None,
        },
        {"filename": "content-config-fake/editorial.yaml"},
        None,
    ],
)
def test_mixed_pr_cannot_misrepresent_engine_changes_as_config_only(
    release, file
):
    api = api_fixture(
        differences={
            f"/compare/{NEW}...{PR}": {"status": "ahead", "files": [file]}
        }
    )
    event = {"pull_request": {"head": {"sha": PR}, "base": {"sha": NEW}}}
    assert release.plan(api, "pull_request", event)["ready"] == "false"
    assert not any("/actions/" in path for _, path, *_ in api.calls)


def test_main_engine_change_waits_for_its_own_successful_ci(release):
    api = api_fixture(
        differences={
            f"/compare/{OLD}...{NEW}": {
                "status": "ahead",
                "files": [
                    {"filename": "newsletter/src/newsletter/content_config.py"}
                ],
            }
        }
    )
    assert (
        release.plan(api, "push", {"ref": "refs/heads/main", "after": NEW})[
            "ready"
        ]
        == "false"
    )
    api = api_fixture(runs=[run_record(NEW)])
    assert release.plan(
        api, "workflow_run", {"workflow_run": run_record(NEW)}
    ) == {
        "ready": "true",
        "revision": NEW,
        "engine_sha": NEW,
    }


@pytest.mark.parametrize(
    "status", ["behind", "diverged", "identical", "unknown"]
)
def test_tested_engine_must_be_same_commit_or_ancestor_not_diverged(
    release, status
):
    api = api_fixture(
        differences={
            f"/compare/{OLD}...{NEW}": {
                "status": status,
                "files": [
                    {"filename": "newsletter/content-config/editorial.yaml"}
                ],
            }
        }
    )
    assert release.compatible_engine(api, NEW) is None


def test_same_engine_needs_no_diff_request_and_empty_tree_diff_is_safe(release):
    api = api_fixture(runs=[run_record(NEW)])
    assert release.compatible_engine(api, NEW) == NEW
    assert not any("/compare/" in path for _, path, *_ in api.calls)
    api = api_fixture(
        differences={
            f"/compare/{OLD}...{NEW}": {"status": "ahead", "files": []}
        }
    )
    assert release.compatible_engine(api, NEW) == OLD


def test_engine_lookup_does_not_trust_the_status_filtered_listing(release):
    # The status=success listing lagged by months on 2026-09-30; the unfiltered
    # listing is newest-first, so success is checked per run instead.
    api = api_fixture(
        runs=[run_record(NEW, conclusion="failure"), run_record(OLD)]
    )
    assert release.compatible_engine(api, NEW) == OLD
    paths = [path for _, path, *_ in api.calls if path.startswith("/actions/")]
    assert paths and all("status=" not in path for path in paths)


@pytest.mark.parametrize(
    "files",
    [None, "not-list", [{"filename": "newsletter/content-config/a"}] * 300],
)
def test_missing_or_truncated_compare_files_cannot_prove_compatibility(
    release, files
):
    api = api_fixture(
        differences={
            f"/compare/{OLD}...{NEW}": {"status": "ahead", "files": files}
        }
    )
    assert release.compatible_engine(api, NEW) is None


@pytest.mark.parametrize(
    "bad",
    [
        run_record(OLD, conclusion="failure"),
        run_record(OLD, event="pull_request"),
        run_record(OLD, head_branch="feature"),
    ],
)
def test_only_successful_main_push_service_ci_is_eligible(release, bad):
    api = api_fixture(runs=[bad, run_record(NEW)])
    assert release.compatible_engine(api, NEW) == NEW


@pytest.mark.parametrize(
    "event",
    [
        {"ref": "refs/heads/main", "after": OLD},
        {"ref": "refs/heads/published", "after": NEW},
    ],
)
def test_stale_or_wrong_branch_push_never_validates_or_publishes(
    release, event
):
    api = api_fixture()
    assert release.plan(api, "push", event)["reason"] == "stale_push"
    api.request.assert_not_called()


@pytest.mark.parametrize(
    "run",
    [
        run_record(NEW, conclusion="failure"),
        run_record(NEW, event="pull_request"),
        run_record(NEW, head_branch="published"),
    ],
)
def test_untrusted_workflow_run_cannot_start_publication(release, run):
    api = api_fixture()
    assert (
        release.plan(api, "workflow_run", {"workflow_run": run})["ready"]
        == "false"
    )
    api.request.assert_not_called()


@pytest.fixture
def artifact(tmp_path):
    raw = json.dumps(
        {"revision": NEW, "synthetic": "image-validated artifact"}
    ).encode()
    (tmp_path / "bundle.json").write_bytes(raw)
    (tmp_path / "validation.json").write_text(
        json.dumps(
            {
                "revision": NEW,
                "engine_sha": OLD,
                "image_id": IMAGE,
                "bundle_sha256": hashlib.sha256(raw).hexdigest(),
            }
        )
    )
    return tmp_path


def publisher(*, parent: str | None = PARENT, mains: list | None = None):
    calls = []

    def request(method, path, value=None, **kwargs):
        calls.append((method, path, value, kwargs))
        if path == "/git/ref/heads/published":
            return {"object": {"sha": parent}} if parent else None
        if path == "/git/blobs":
            return {"sha": BLOB}
        if path == "/git/trees":
            return {"sha": TREE}
        if path == "/git/commits":
            return {"sha": COMMIT}
        if path in {"/git/refs/heads/published", "/git/refs"}:
            return {}
        raise AssertionError("unexpected publication path")

    return types.SimpleNamespace(
        main=mock.Mock(side_effect=mains or [NEW, NEW]),
        request=mock.Mock(side_effect=request),
        calls=calls,
    )


def test_publisher_writes_single_bundle_tree_with_nonforce_parent_cas(
    release, artifact
):
    api = publisher()
    assert release.publish(api, NEW, artifact)
    blob = next(
        value for _, path, value, _ in api.calls if path == "/git/blobs"
    )
    assert (
        base64.b64decode(blob["content"])
        == (artifact / "bundle.json").read_bytes()
    )
    tree = next(
        value for _, path, value, _ in api.calls if path == "/git/trees"
    )
    assert tree == {
        "tree": [
            {
                "path": "bundle.json",
                "mode": "100644",
                "type": "blob",
                "sha": BLOB,
            }
        ]
    }
    commit = next(
        value for _, path, value, _ in api.calls if path == "/git/commits"
    )
    assert commit["parents"] == [PARENT]
    assert api.calls[-1] == (
        "PATCH",
        "/git/refs/heads/published",
        {"sha": COMMIT, "force": False},
        {},
    )
    assert api.main.call_count == 2
    assert all("main" not in path for _, path, *_ in api.calls)


def test_first_publication_creates_only_published_branch(release, artifact):
    api = publisher(parent=None)
    assert release.publish(api, NEW, artifact)
    assert api.calls[-1] == (
        "POST",
        "/git/refs",
        {"ref": "refs/heads/published", "sha": COMMIT},
        {},
    )
    commit = next(
        value for _, path, value, _ in api.calls if path == "/git/commits"
    )
    assert commit["parents"] == []


@pytest.mark.parametrize("mains", [[OLD], [NEW, OLD]])
def test_main_advance_never_updates_visible_publication(
    release, artifact, mains
):
    api = publisher(mains=mains)
    assert not release.publish(api, NEW, artifact)
    assert not any(path.startswith("/git/refs") for _, path, *_ in api.calls)


@pytest.mark.parametrize(
    "field,value",
    [
        ("revision", OLD),
        ("engine_sha", "main"),
        ("image_id", "service:latest"),
        ("bundle_sha256", "incorrect"),
    ],
)
def test_tampered_receipt_cannot_publish(release, artifact, field, value):
    receipt = json.loads((artifact / "validation.json").read_bytes())
    receipt[field] = value
    (artifact / "validation.json").write_text(json.dumps(receipt))
    api = publisher()
    with pytest.raises(release.ReleaseError):
        release.publish(api, NEW, artifact)
    api.main.assert_not_called()
    api.request.assert_not_called()


def test_ambiguous_ref_update_is_not_blindly_retried(release, artifact):
    api = publisher()
    original = api.request.side_effect

    def fail_once(method, path, value=None, **kwargs):
        if method == "PATCH":
            raise release.ReleaseError("ambiguous network outcome")
        return original(method, path, value, **kwargs)

    api.request.side_effect = fail_once
    with pytest.raises(release.ReleaseError):
        release.publish(api, NEW, artifact)
    assert (
        sum(call.args[0] == "PATCH" for call in api.request.call_args_list) == 1
    )


def test_validation_uses_exact_image_id_host_owned_output_and_no_network(
    release, tmp_path, monkeypatch
):
    source = tmp_path / "source"
    source.mkdir()
    output = tmp_path / "output"
    calls = []

    def run(arguments, **options):
        calls.append((arguments, options))
        if arguments[1:3] == ["image", "inspect"]:
            return types.SimpleNamespace(
                stdout=json.dumps(
                    {"id": IMAGE, "os": "linux", "architecture": "amd64"}
                )
            )
        if arguments[1] == "run" and "build" in arguments:
            (output / "bundle.json").write_text(json.dumps({"revision": NEW}))
        return types.SimpleNamespace(stdout="")

    monkeypatch.setattr(release.subprocess, "run", run)
    monkeypatch.setenv("GITHUB_REPOSITORY", "ziyixi/todofy")
    tag = "ghcr.io/ziyixi/todofy-newsletter:service-" + OLD
    release.validate(tag, OLD, NEW, source, output, pull=True)
    containers = [arguments for arguments, _ in calls if arguments[1] == "run"]
    assert len(containers) == 2
    assert calls[0][0] == [
        "docker",
        "pull",
        "--platform",
        "linux/amd64",
        "--",
        tag,
    ]
    for arguments in containers:
        for option, value in (
            ("--network", "none"),
            ("--pull", "never"),
            ("--user", f"{os.getuid()}:{os.getgid()}"),
            ("--platform", "linux/amd64"),
            ("--memory", "256m"),
        ):
            assert arguments[arguments.index(option) + 1] == value
        assert IMAGE in arguments and tag not in arguments
        assert "--read-only" in arguments
        assert not {"--env", "--env-file", "-e", "--privileged"} & set(
            arguments
        )
        assert all("docker.sock" not in item for item in arguments)
    assert f"type=bind,src={source},dst=/config,readonly" in containers[0]
    assert f"type=bind,src={output},dst=/out,readonly" in containers[1]
    receipt = json.loads((output / "validation.json").read_bytes())
    assert receipt["image_id"] == IMAGE and receipt["engine_sha"] == OLD
    assert (
        receipt["bundle_sha256"]
        == hashlib.sha256((output / "bundle.json").read_bytes()).hexdigest()
    )
    assert (
        len([arguments for arguments, _ in calls if arguments[1] == "rm"]) == 2
    )


@pytest.mark.parametrize(
    "architecture,image_id", [("arm64", IMAGE), ("amd64", "mutable:tag")]
)
def test_wrong_architecture_or_mutable_image_stops_before_container(
    release, tmp_path, monkeypatch, architecture, image_id
):
    source = tmp_path / "source"
    source.mkdir()
    calls = []

    def run(arguments, **kwargs):
        calls.append(arguments)
        return types.SimpleNamespace(
            stdout=json.dumps(
                {"id": image_id, "os": "linux", "architecture": architecture}
            )
        )

    monkeypatch.setattr(release.subprocess, "run", run)
    with pytest.raises(release.ReleaseError):
        release.validate(
            "local-test", OLD, NEW, source, tmp_path / "out", pull=False
        )
    assert len(calls) == 1


def test_validation_timeout_cleans_only_its_unique_container(
    release, monkeypatch
):
    calls = []

    def run(arguments, **kwargs):
        calls.append((arguments, kwargs))
        if arguments[1] == "run":
            raise subprocess.TimeoutExpired(SECRET, 180)
        return types.SimpleNamespace(stdout="")

    monkeypatch.setattr(release.subprocess, "run", run)
    with pytest.raises(release.ReleaseError) as caught:
        release.run_container(
            release.docker_base(IMAGE) + [IMAGE, "-m", "newsletter.config_cli"]
        )
    name = calls[0][0][calls[0][0].index("--name") + 1]
    assert name.startswith("newsletter-content-validation-")
    assert calls[-1][0] == ["docker", "rm", "--force", name]
    assert calls[-1][1]["timeout"] == 15
    assert SECRET not in str(caught.value)


def test_api_credentials_have_fixed_origin_no_redirect_or_environment_proxy(
    release, monkeypatch
):
    handlers = []
    opener = mock.Mock()
    opener.open.return_value = io.BytesIO(b'{"synthetic":true}')

    def build(*values):
        handlers.extend(values)
        return opener

    monkeypatch.setattr(release.urllib_request, "build_opener", build)
    api = release.GitHub("ziyixi/newsletter", SECRET)
    assert api.request("GET", "/git/ref/heads/main") == {"synthetic": True}
    request = opener.open.call_args.args[0]
    assert (
        request.full_url
        == "https://api.github.com/repos/ziyixi/newsletter/git/ref/heads/main"
    )
    assert request.get_header("Authorization") == "Bearer " + SECRET
    assert opener.open.call_args.kwargs["timeout"] == 30
    assert any(isinstance(handler, release.NoRedirect) for handler in handlers)
    assert any(
        isinstance(handler, release.urllib_request.ProxyHandler)
        and handler.proxies == {}
        for handler in handlers
    )
    assert (
        release.NoRedirect().redirect_request(
            None, None, 302, "", {}, "https://evil.invalid"
        )
        is None
    )


@pytest.mark.parametrize(
    "error",
    [
        urllib_error.HTTPError("https://example.org", 403, SECRET, {}, None),
        urllib_error.HTTPError(
            "https://example.org",
            302,
            SECRET,
            {"Location": "https://evil.invalid"},
            None,
        ),
        urllib_error.URLError(SECRET),
        TimeoutError(SECRET),
    ],
)
def test_api_failures_never_echo_credentials_or_remote_text(release, error):
    api = release.GitHub("ziyixi/newsletter", SECRET)
    api.opener = mock.Mock()
    api.opener.open.side_effect = error
    with pytest.raises(release.ReleaseError) as caught:
        api.request("GET", "/git/ref/heads/main")
    assert SECRET not in str(caught.value)


def test_workflow_permissions_and_event_isolation_are_least_privilege():
    config = workflows.load("content-config.yml")
    service = workflows.load("ci.yml")
    assert config["permissions"] == {"contents": "read"}
    assert config["jobs"]["validate"]["permissions"] == {
        "contents": "read",
        "actions": "read",
    }
    assert config["jobs"]["publish"]["permissions"] == {"contents": "write"}
    assert (
        "github.event_name != 'pull_request'" in config["jobs"]["publish"]["if"]
    )
    assert config["on"]["push"] == {
        "branches": ["main"],
        "paths": ["newsletter/content-config/**"],
    }
    assert config["on"]["workflow_run"]["workflows"] == ["CI and deploy"]
    assert config["on"]["workflow_run"]["branches"] == ["main"]
    assert "pull_request_target" not in config["on"]
    assert service["jobs"]["newsletter-checks"]["if"] == (
        "needs.changes.outputs.newsletter_check == 'true'"
    )
    configured_environments = []
    for job in config["jobs"].values():
        assert job.get("permissions", {}).get("packages") != "write"
        configured_environments.append(job.get("env", {}))
        for step in job["steps"]:
            assert "docker build" not in step.get("run", "")
            configured_environments.append(step.get("env", {}))
            if str(step.get("uses", "")).startswith("actions/checkout"):
                assert step["with"]["persist-credentials"] == "false"
    assert any(
        environment.get("GITHUB_TOKEN") == "${{ github.token }}"
        for environment in configured_environments
    )
    assert all(
        not {"NEWSLETTER_SEND_TOKEN", "RESEND_API_KEY"} & environment.keys()
        for environment in configured_environments
    )
    image_steps = service["jobs"]["newsletter-image"]["steps"]
    assert any(
        "publish_content_config.py validate" in step.get("run", "")
        for step in image_steps
    )
    publish_job = service["jobs"]["newsletter-deploy"]
    assert publish_job["name"] == "Newsletter image publish"
    assert "newsletter-image" in publish_job["needs"]
    assert any(
        "image.py publish" in step.get("run", "")
        for step in publish_job["steps"]
    )


@pytest.mark.parametrize(
    "conclusion", ["skipped", "failure", "cancelled", None]
)
def test_green_run_without_actual_image_publication_is_ineligible(
    release, conclusion
):
    api = api_fixture(runs=[run_record(NEW)])
    original = api.request.side_effect

    def request(method, path, value=None, **kwargs):
        if path.startswith("/actions/runs/"):
            return {
                "jobs": [
                    {
                        "name": "Newsletter image publish",
                        "conclusion": conclusion,
                    }
                ]
            }
        return original(method, path, value, **kwargs)

    api.request.side_effect = request
    assert release.compatible_engine(api, NEW) is None


def test_image_job_listing_is_paginated_and_requires_exact_job(release):
    api = api_fixture(runs=[run_record(NEW)])
    original = api.request.side_effect

    def request(method, path, value=None, **kwargs):
        if path.startswith("/actions/runs/"):
            if path.endswith("&page=1"):
                return {
                    "jobs": [{"name": "unrelated", "conclusion": "success"}]
                    * 100
                }
            return {
                "jobs": [
                    {
                        "name": "Newsletter image publish",
                        "conclusion": "success",
                    }
                ]
            }
        return original(method, path, value, **kwargs)

    api.request.side_effect = request
    assert release.compatible_engine(api, NEW) == NEW
