"""Offline regression checks for the shared dependency and build boundaries.

These inspect tracked configuration, not a developer's environment, credentials,
Docker daemon, or installed package cache. CI separately installs and builds;
matching configuration alone does not prove a build works.
"""

from __future__ import annotations

import json
import pathlib
import re
import tomllib
import urllib.parse as parse

import tests.support.workflows as workflows

ROOT = pathlib.Path(__file__).resolve().parents[1]


def read_config(name: str) -> dict:
    return tomllib.loads((ROOT / name).read_text())


def test_uv_is_the_only_lock_and_direct_pins_match_resolution():
    project = read_config("pyproject.toml")
    lock = read_config("uv.lock")
    assert not (ROOT / "requirements.lock").exists()
    assert "dev" not in project["project"].get("optional-dependencies", {})
    assert "codex" in project["project"]["optional-dependencies"]

    declared = [
        *project["project"]["dependencies"],
        *project["project"]["optional-dependencies"]["codex"],
        *project["dependency-groups"]["dev"],
    ]
    resolved = {
        (package["name"], package["version"]) for package in lock["package"]
    }
    for requirement in declared:
        name, version = requirement.split("==")
        assert (re.sub(r"[-_.]+", "-", name.lower()), version) in resolved


def test_registry_artifacts_are_hash_locked():
    for package in read_config("uv.lock")["package"]:
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


def test_python_and_uv_versions_are_shared_by_local_ci_and_docker():
    project = read_config("pyproject.toml")
    python_version = (ROOT / ".python-version").read_text().strip()
    assert re.fullmatch(r"3\.12\.\d+", python_version)
    assert project["project"]["requires-python"] == ">=3.12,<3.13"
    assert read_config("uv.lock")["requires-python"] == "==3.12.*"
    uv_version = project["tool"]["uv"]["required-version"].removeprefix("==")
    assert re.fullmatch(r"\d+\.\d+\.\d+", uv_version)

    dockerfile = (ROOT / "Dockerfile").read_text()
    python_images = re.findall(r"(?im)^FROM python:([^\s]+)", dockerfile)
    assert python_images and all(
        image.startswith(python_version + "-") for image in python_images
    )
    assert f"ghcr.io/astral-sh/uv:{uv_version}" in dockerfile
    steps = workflows.load("ci.yml")["jobs"]["newsletter-checks"]["steps"]
    uv = next(
        step
        for step in steps
        if step.get("uses", "").startswith("astral-sh/setup-uv@")
    )
    assert uv["with"]["working-directory"] == "newsletter"
    assert uv["with"]["version"] == uv_version


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
    project = read_config("pyproject.toml")
    declaration = next(
        item
        for item in project["project"]["dependencies"]
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
        for item in read_config("uv.lock")["package"]
        if item["name"] == "ziyixi-protos"
    )
    assert locked["version"] == package_version
    assert locked["source"] == {"url": source["url"]}
    assert locked["wheels"] and all(
        re.fullmatch(r"sha256:[a-f0-9]{64}", wheel["hash"])
        for wheel in locked["wheels"]
    )


def test_make_has_one_locked_install_and_shared_quality_gate():
    makefile = (ROOT / "Makefile").read_text()
    setup = re.search(r"(?m)^setup:[^\n]*\n((?:\t[^\n]*\n)+)", makefile)
    assert setup is not None
    assert all(
        option in setup[1] for option in ("sync", "--locked", "--extra codex")
    )
    assert "requirements.lock" not in makefile
    assert "pip install" not in makefile
    gate = re.search(r"(?m)^check:([^\n]*)", makefile)
    assert gate is not None
    assert {"lock-check", "lint", "typecheck", "test"} <= set(gate[1].split())
    for target in ("build", "smoke", "proto-check"):
        assert re.search(r"(?m)^" + target + r":", makefile)


def test_docker_context_only_allows_build_inputs():
    rules = [
        line.strip()
        for line in (ROOT / ".dockerignore").read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert rules[0] == "**"
    allowed = {rule[1:] for rule in rules if rule.startswith("!")}
    assert {"pyproject.toml", "uv.lock"} <= allowed
    assert allowed <= {
        "pyproject.toml",
        "uv.lock",
        ".python-version",
        "MANIFEST.in",
        "Dockerfile",
        "src/",
        "src/newsletter/",
        "src/newsletter/**",
    }
    assert "**/__pycache__/" in rules and "**/*.pyc" in rules


def test_docker_installs_locked_production_environment_and_starts_directly():
    dockerfile = (ROOT / "Dockerfile").read_text().replace("\\\n", " ")
    install_lines = [
        line for line in dockerfile.splitlines() if "uv sync" in line
    ]
    assert install_lines
    for line in install_lines:
        assert all(
            option in line
            for option in ("--locked", "--no-dev", "--extra codex")
        )
        # A dependency-cache stage may deliberately omit the project entirely.
        assert "--no-install-project" in line or "--no-editable" in line
    assert "--no-editable" in install_lines[-1]
    runtime = re.split(r"(?im)^FROM ", dockerfile)[-1]
    assert re.search(r"(?m)^USER (?!root\b|0\b)\S+", runtime)
    entrypoint = re.search(r"(?m)^ENTRYPOINT (\[.*\])$", runtime)
    assert entrypoint is not None
    assert pathlib.Path(json.loads(entrypoint[1])[0]).name == "newsletter"
    startup = "\n".join(
        line
        for line in runtime.splitlines()
        if line.startswith(("RUN ", "CMD ", "ENTRYPOINT "))
    )
    assert not re.search(r"\b(?:uv|pip)\b", startup)


def test_ci_uses_the_same_quality_gate_before_image_build():
    jobs = workflows.load("ci.yml")["jobs"]
    commands = "\n".join(
        step.get("run", "") for step in jobs["newsletter-checks"]["steps"]
    )
    assert all(
        command in commands
        for command in ("make check", "make smoke", "make build")
    )
    reusable = {job["uses"] for job in jobs.values() if "uses" in job}
    assert reusable == {"./.github/workflows/worker-release.yml"}
    assert all(
        "steps" in job or job.get("uses") in reusable for job in jobs.values()
    )
    checked_jobs = [job for job in jobs.values() if "steps" in job]
    checked_jobs.extend(workflows.load("worker-release.yml")["jobs"].values())
    assert all(
        "requirements.lock" not in command and "pip install" not in command
        for job in checked_jobs
        for step in job["steps"]
        for command in [step.get("run", "")]
    )
    needs = jobs["newsletter-image"]["needs"]
    assert "newsletter-checks" in ([needs] if isinstance(needs, str) else needs)
