"""Offline model boundaries: exact parser limits and safe job directories."""

import json
import stat

import pytest

import newsletter.errors as errors
import newsletter.model_io as model_io


@pytest.mark.parametrize(
    "value", [{"中文": [True, 3, None]}, [], "text", 2, False, None]
)
def test_load_json_preserves_values_without_imposing_output_shape(value):
    assert model_io.load_json(json.dumps(value, ensure_ascii=False)) == value


@pytest.mark.parametrize(
    "raw",
    [
        '{"same":1,"same":2}',
        '{"nested":{"same":1,"same":2}}',
        "NaN",
        "Infinity",
        "-Infinity",
        "```json\n{}\n```",
        "",
        b"{}",
        None,
        {},
    ],
)
def test_invalid_json_has_the_existing_safe_error(raw):
    with pytest.raises(errors.EditorError) as error:
        model_io.load_json(raw)
    assert error.value.code == "invalid_output"


def test_json_budget_counts_utf8_bytes_and_accepts_the_exact_limit():
    raw = '"中"'
    exact = raw + " " * (model_io.MAX_JSON_BYTES - len(raw.encode("utf-8")))
    assert len(exact.encode("utf-8")) == model_io.MAX_JSON_BYTES
    assert model_io.load_json(exact) == "中"
    with pytest.raises(errors.EditorError) as error:
        model_io.load_json(exact + " ")
    assert error.value.code == "invalid_output"


def test_parser_recursion_failure_keeps_the_safe_error(monkeypatch):
    def recursion_failure(*args, **kwargs):
        raise RecursionError("synthetic parser failure")

    # Python decoder recursion limits vary; test the existing mapping directly.
    monkeypatch.setattr(model_io.json, "loads", recursion_failure)
    with pytest.raises(errors.EditorError) as error:
        model_io.load_json("[]")
    assert error.value.code == "invalid_output"
    assert error.value.__cause__ is None


def test_workspace_creates_a_private_canonical_directory_and_retains_history(
    tmp_path,
):
    requested = tmp_path / "jobs" / "edition"
    workspace = model_io.prepare_workspace(requested, "2026-09-05")
    assert workspace == requested.absolute()
    assert (
        workspace.is_dir() and stat.S_IMODE(workspace.stat().st_mode) == 0o700
    )
    history = workspace / "recent-history.json"
    history.write_text("[]")
    assert model_io.prepare_workspace(requested, "2026-09-05") == workspace
    assert history.read_text() == "[]"


def test_existing_workspace_permissions_are_not_changed(tmp_path):
    workspace = tmp_path / "existing"
    workspace.mkdir(mode=0o755)
    before = stat.S_IMODE(workspace.stat().st_mode)
    assert model_io.prepare_workspace(workspace, "2026-09-05") == workspace
    assert stat.S_IMODE(workspace.stat().st_mode) == before


@pytest.mark.parametrize(
    "issue_date",
    ["20260905", "2026-9-5", "2026-02-30", "2026-09-05T00:00:00", "", None],
)
def test_invalid_date_fails_before_creating_workspace(tmp_path, issue_date):
    workspace = tmp_path / "must-not-exist"
    with pytest.raises(errors.EditorError) as error:
        model_io.prepare_workspace(workspace, issue_date)
    assert error.value.code == "invalid_input"
    assert not workspace.exists()


@pytest.mark.parametrize(
    "name", ["draft.json", "review.json", "supplemental.json"]
)
@pytest.mark.parametrize("kind", ["file", "directory", "dangling-symlink"])
def test_stale_artifacts_are_rejected_without_overwrite(tmp_path, name, kind):
    workspace = tmp_path / "job"
    workspace.mkdir()
    artifact = workspace / name
    if kind == "file":
        artifact.write_text("existing fixture data")
    elif kind == "directory":
        artifact.mkdir()
    else:
        artifact.symlink_to(tmp_path / "missing-target")
    with pytest.raises(errors.EditorError) as error:
        model_io.prepare_workspace(workspace, "2026-09-05")
    assert error.value.code == "invalid_input"
    if kind == "file":
        assert artifact.read_text() == "existing fixture data"
    elif kind == "directory":
        assert artifact.is_dir()
    else:
        assert artifact.is_symlink() and not artifact.exists()


@pytest.mark.parametrize("symlink_is_final", [True, False])
def test_workspace_rejects_final_or_ancestor_symlinks(
    tmp_path, symlink_is_final
):
    target = tmp_path / "real-directory"
    target.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(target, target_is_directory=True)
    workspace = linked if symlink_is_final else linked / "job"
    with pytest.raises(errors.EditorError) as error:
        model_io.prepare_workspace(workspace, "2026-09-05")
    assert error.value.code == "invalid_input"
    assert list(target.iterdir()) == []


def test_workspace_file_is_not_replaced_with_directory(tmp_path):
    workspace = tmp_path / "not-a-directory"
    workspace.write_text("existing fixture data")
    with pytest.raises(errors.EditorError) as error:
        model_io.prepare_workspace(workspace, "2026-09-05")
    assert error.value.code == "invalid_input"
    assert workspace.read_text() == "existing fixture data"
