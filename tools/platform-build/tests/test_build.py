"""The OCI context contains production code, baked identity and reviewed resources only."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "platform_build", ROOT / "tools/platform-build/build.py"
)
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


def test_image_context_identity_and_reviewed_manifest_asset(tmp_path):
    sha = "a" * 40
    build.build(sha, tmp_path / "artifact")
    context = tmp_path / "artifact"
    app = context / "app"
    names = [
        path.relative_to(app).as_posix() for path in app.rglob("*") if path.is_file()
    ]
    assert all(name.startswith(("personal_cloud/", "ziyixi_proto/")) for name in names)
    assert not any(".env" in name or "__pycache__" in name for name in names)
    assert not any(name.startswith("ziyixi_proto/prototest/") for name in names)
    assert json.loads((app / "personal_cloud/build-info.json").read_text()) == {
        "source_sha": sha
    }
    assert json.loads((context / "build-info.json").read_text()) == {"source_sha": sha}
    resources = json.loads((app / "personal_cloud/resources.json").read_text())
    assert resources["kind"] == "List"
    assert len(resources["items"]) == 10
    runtime = next(
        item
        for item in resources["items"]
        if item["kind"] == "Deployment"
        and item["metadata"]["name"] == "platform-runtime"
    )
    assert (
        runtime["spec"]["template"]["spec"]["serviceAccountName"]
        == "platform-controller"
    )
    assert all(
        item["kind"] in {"Deployment", "CronJob", "ConfigMap", "Service"}
        for item in resources["items"]
    )
    assert (tmp_path / "artifact/platform/uv.lock").is_file()
    assert (tmp_path / "artifact/proto/python/pyproject.toml").is_file()


def test_invalid_identity_does_not_create_a_partial_artifact(tmp_path):
    import pytest

    with pytest.raises(ValueError, match="full source SHA"):
        build.build("HEAD", tmp_path / "bad")
    assert not (tmp_path / "bad").exists()
