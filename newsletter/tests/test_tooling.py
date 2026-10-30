"""Offline regression checks for the shared dependency and build boundaries.

These inspect tracked configuration, not a developer's environment, credentials,
Docker daemon, or installed package cache. CI separately installs and builds;
matching configuration alone does not prove a build works.
"""

from __future__ import annotations

import ast
import json
import pathlib
import re
import tomllib
import urllib.parse as parse

import tests.support.workflows as workflows

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent


def read_config(name: str, root: pathlib.Path = ROOT) -> dict:
    return tomllib.loads((root / name).read_text())


def test_uv_is_the_only_lock_and_direct_pins_match_resolution():
    project = read_config("pyproject.toml")
    workspace = read_config("pyproject.toml", WORKSPACE)
    lock = read_config("uv.lock", WORKSPACE)
    assert not (ROOT / "uv.lock").exists()
    assert not (ROOT / "requirements.lock").exists()
    assert "optional-dependencies" not in project["project"]

    declared = [
        *project["project"]["dependencies"],
        *project["dependency-groups"]["dev"],
    ]
    resolved = {
        (package["name"], package["version"]) for package in lock["package"]
    }
    constraints = dict(
        item.split("==")
        for item in workspace["tool"]["uv"]["constraint-dependencies"]
    )
    for name in declared:
        assert re.fullmatch(r"[A-Za-z0-9_.-]+", name)
        if name in {"ziyixi-proto", "ziyixi-model-router-client"}:
            assert workspace["tool"]["uv"]["sources"][name]["workspace"]
            assert any(package["name"] == name for package in lock["package"])
            continue
        version = constraints[name]
        assert (re.sub(r"[-_.]+", "-", name.lower()), version) in resolved


def test_registry_artifacts_are_hash_locked():
    for package in read_config("uv.lock", WORKSPACE)["package"]:
        if "registry" not in package["source"]:
            continue
        artifacts = [*package.get("wheels", [])]
        if "sdist" in package:
            artifacts.append(package["sdist"])
        assert artifacts, package["name"]
        assert all(
            re.fullmatch(r"sha256:[a-f0-9]{64}", item["hash"])
            for item in artifacts
        )


def test_python_version_and_oci_base_are_fixed_by_the_repository():
    project = read_config("pyproject.toml", WORKSPACE)
    python_version = (WORKSPACE / ".python-version").read_text().strip()
    assert re.fullmatch(r"3\.14\.\d+", python_version)
    assert project["project"]["requires-python"] == ">=3.14,<3.15"
    assert read_config("uv.lock", WORKSPACE)["requires-python"] == "==3.14.*"
    module = (WORKSPACE / "MODULE.bazel").read_text()
    assert f'python_version = "{python_version}"' in module
    assert re.search(r'digest = "sha256:[0-9a-f]{64}"', module)
    # The live image probe checks the same full interpreter version.
    probe = (ROOT / "scripts/smoke_image_probe.py").read_text()
    assert 'sys.version.split()[0] == payload["python_version"]' in probe


def test_mypy_checks_service_without_vendoring_proto_artifacts():
    project = read_config("pyproject.toml")
    mypy = project["tool"]["mypy"]
    assert "src/newsletter" in mypy["files"]
    assert mypy["check_untyped_defs"] and mypy["disallow_untyped_defs"]
    assert not mypy.get("ignore_errors", False)
    assert not any(
        "generated" in item
        for item in project["tool"]["setuptools"]["package-data"]["newsletter"]
    )
    assert not (ROOT / "src/newsletter/generated/editorial_pb2.py").exists()
    assert not (ROOT / "scripts/generate_proto.py").exists()


def test_public_proto_uses_a_hash_locked_github_release_not_local_source():
    project = read_config("pyproject.toml", WORKSPACE)
    assert (
        "ziyixi-protos"
        in read_config("pyproject.toml")["project"]["dependencies"]
    )
    declaration = next(
        item
        for item in project["tool"]["uv"]["constraint-dependencies"]
        if item.startswith("ziyixi-protos==")
    )
    package_version = declaration.split("==", 1)[1]
    source = project["tool"]["uv"]["sources"]["ziyixi-protos"]
    assert set(source) == {"url"}
    url = parse.urlsplit(source["url"])
    assert url.scheme == "https" and url.netloc == "github.com"
    assert url.path.startswith("/ziyixi/protos/releases/download/")
    assert url.path.endswith(
        "/ziyixi_protos-" + package_version + "-py3-none-any.whl"
    )
    assert not url.username and not url.password and not url.query
    locked = next(
        item
        for item in read_config("uv.lock", WORKSPACE)["package"]
        if item["name"] == "ziyixi-protos"
    )
    assert locked["version"] == package_version
    assert locked["source"] == {"url": source["url"]}
    assert locked["wheels"] and all(
        re.fullmatch(r"sha256:[a-f0-9]{64}", wheel["hash"])
        for wheel in locked["wheels"]
    )


def test_make_commands_are_thin_bazel_aliases():
    makefile = (ROOT / "Makefile").read_text()
    expected = {
        "test": "test //newsletter:tests",
        "lint": "test //newsletter:ruff_check_test",
        "typecheck": "test //newsletter:mypy_test",
        "check": "test //newsletter:check",
        "build": "build //newsletter ",
        "smoke": "test //newsletter:smoke_http_test",
        "smoke-codex": "test //newsletter:smoke_codex_startup_test",
        "format": "run //newsletter:format",
        "proto-check": "test //newsletter:wheel_smoke_test",
    }
    for target, command in expected.items():
        body = re.search(
            r"(?m)^" + re.escape(target) + r":[^\n]*\n((?:\t[^\n]*\n)+)",
            makefile,
        )
        assert body is not None
        assert "$(BAZEL) " + command in body[1]
        assert "$(RUN)" not in body[1] and "uv " not in body[1]
    assert "--embed_label=$(SOURCE_SHA)" in makefile


def test_root_check_includes_the_original_engine_validation():
    tree = ast.parse((ROOT / "BUILD.bazel").read_text())
    suite = next(
        node.value
        for node in tree.body
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Name)
        and node.value.func.id == "test_suite"
        and any(
            keyword.arg == "name"
            and isinstance(keyword.value, ast.Constant)
            and keyword.value.value == "check"
            for keyword in node.value.keywords
        )
    )
    tests = ast.literal_eval(
        next(
            keyword.value
            for keyword in suite.keywords
            if keyword.arg == "tests"
        )
    )
    assert {
        ":tests",
        ":ruff_check_test",
        ":ruff_format_test",
        ":python_structure_test",
        ":mypy_test",
        ":smoke_http_test",
        ":smoke_codex_startup_test",
        ":wheel_smoke_test",
    } <= set(tests)


def test_bazel_image_uses_generated_shared_wheels():
    source = (ROOT / "BUILD.bazel").read_text()
    assert 'whl = "//proto:python_wheel"' in source
    assert 'whl = "//packages/model-router-client/python:wheel"' in source
    commands = "\n".join(
        step.get("run", "")
        for step in workflows.load("ci.yml")["jobs"]["artifacts"]["steps"]
    )
    assert "container-release/build.py --service newsletter" in commands


def test_image_starts_the_installed_service_and_retains_http_healthcheck():
    health = json.loads((ROOT / "container-healthcheck.json").read_text())
    assert health == {
        "Test": [
            "CMD-SHELL",
            'python -c "import urllib.request; '
            "urllib.request.urlopen('http://127.0.0.1:8080/healthz', "
            'timeout=3)"',
        ],
        "Interval": 30_000_000_000,
        "Timeout": 5_000_000_000,
        "StartPeriod": 90_000_000_000,
    }
    tree = ast.parse((ROOT / "BUILD.bazel").read_text())
    image = next(
        node.value
        for node in tree.body
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Name)
        and node.value.func.id == "oci_image"
    )
    attributes = {
        keyword.arg: ast.literal_eval(keyword.value)
        for keyword in image.keywords
    }
    assert attributes["user"] == "newsletter"
    assert attributes["entrypoint"] == ["newsletter"]
    assert attributes["cmd"] == ["serve", "--host", "0.0.0.0", "--port", "8080"]
    assert "NEWSLETTER_CHART_FONT" in attributes["env"]


def test_ci_requires_leaf_checks_and_artifacts_before_publication():
    jobs = workflows.load("ci.yml")["jobs"]
    assert "ci/run.py --plan" in "\n".join(
        step.get("run", "") for step in jobs["checks"]["steps"]
    )
    assert set(jobs["gate"]["needs"]) == {"changes", "checks", "artifacts"}
    assert "needs.gate.result == 'success'" in jobs["newsletter-deploy"]["if"]
    assert "github.ref == 'refs/heads/main'" in jobs["newsletter-deploy"]["if"]
    checked_jobs = [job for job in jobs.values() if "steps" in job]
    checked_jobs.extend(workflows.load("worker-release.yml")["jobs"].values())
    assert all(
        "requirements.lock" not in step.get("run", "")
        and "pip install" not in step.get("run", "")
        for job in checked_jobs
        for step in job["steps"]
    )
