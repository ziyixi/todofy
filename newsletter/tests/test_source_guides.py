"""Test guide loading, packaging and snapshots without network or models."""

import importlib.resources as resources
import pathlib
import tomllib

import pytest

import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.collection.repository as repository
import newsletter.collection.source_guides as source_guides
import newsletter.contracts as contracts
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.workflow.pipeline as pipeline
import newsletter.workflow.state as newsletter_workflow_state


def setup_guide(tmp_path, text="Public source guide, not an approval"):
    directory = tmp_path / "discovery"
    directory.mkdir()
    (directory / "01-ai-ml.md").write_text(
        "Synthetic AI direction", encoding="utf-8"
    )
    (directory / "02-science.md").write_text(
        "Synthetic science direction", encoding="utf-8"
    )
    folder = directory / "_sources"
    folder.mkdir()
    path = folder / "ai-ml.md"
    path.write_text(text, encoding="utf-8")
    return directory, path


def test_source_guide_is_one_frozen_direction_not_a_new_worker(tmp_path):
    directory, _ = setup_guide(tmp_path)
    plain = newsletter_collection_instructions.load_instructions(directory)
    augmented = source_guides.load_discovery_instructions(directory)
    assert [item.id for item in augmented] == [item.id for item in plain]
    assert augmented[1] == plain[1]
    assert "Public source guide" in augmented[0].text
    assert augmented[0].digest == contracts.content_hash(augmented[0].text)
    assert augmented[0].digest != plain[0].digest


@pytest.mark.parametrize("empty_folder", [False, True])
def test_old_custom_directory_without_source_guide_keeps_exact_instruction_hash(
    tmp_path, empty_folder
):
    (tmp_path / "01-ai-ml.md").write_text(
        "Legacy instruction", encoding="utf-8"
    )
    if empty_folder:
        (tmp_path / "_sources").mkdir()
    assert source_guides.load_discovery_instructions(
        tmp_path
    ) == newsletter_collection_instructions.load_instructions(tmp_path)


def test_guide_edits_affect_next_run_not_frozen_snapshot(
    tmp_path,
):
    directory, path = setup_guide(tmp_path)
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        state = newsletter_workflow_state.WorkflowState(store)
        runs = repository.RunRepository(store)
        settings = newsletter_settings.Settings(
            data_dir=tmp_path, discovery_dir=directory
        )
        instructions, snapshot = pipeline.freeze_workflow(
            settings, state, "2026-09-06"
        )
        run = runs.start(
            {"request_key": "old-guide", "issue_date": "2026-09-06"},
            instructions,
            workflow_snapshot=snapshot,
        )
        digest = contracts.content_hash(snapshot)
        path.write_text("Changed public source guide", encoding="utf-8")
        newer, _ = pipeline.freeze_workflow(settings, state, "2026-09-06")
        assert newer[0].digest != instructions[0].digest
        assert newer[1].digest == instructions[1].digest
        assert (
            contracts.content_hash(runs.workflow_snapshot(run["id"])) == digest
        )
        claimed = runs.claim()
        assert claimed is not None and claimed[1] == instructions
        assert runs.get(run["id"])[
            "instructions_hash"
        ] == contracts.content_hash([item.snapshot() for item in instructions])
    finally:
        store.close()


@pytest.mark.parametrize(
    "raw",
    [b"", b"\xff", b"bad\x00guide", b"a" * (source_guides.MAX_GUIDE_BYTES + 1)],
)
def test_guide_rejects_empty_invalid_or_oversized_bytes(tmp_path, raw):
    directory, path = setup_guide(tmp_path)
    path.write_bytes(raw)
    with pytest.raises(newsletter_collection_instructions.InstructionError):
        source_guides.load_discovery_instructions(directory)


def test_combined_instruction_limit_is_enforced(tmp_path):
    directory, _ = setup_guide(tmp_path, "g" * 16_000)
    (directory / "01-ai-ml.md").write_text("i" * 10_000, encoding="utf-8")
    with pytest.raises(newsletter_collection_instructions.InstructionError):
        source_guides.load_discovery_instructions(directory)


@pytest.mark.parametrize(
    "kind",
    ["guide_symlink", "folder_symlink", "guide_directory", "folder_file"],
)
def test_guide_does_not_follow_symlinks_or_non_files(tmp_path, kind):
    directory = tmp_path / "discovery"
    directory.mkdir()
    (directory / "01-ai-ml.md").write_text(
        "Synthetic direction", encoding="utf-8"
    )
    folder = directory / "_sources"
    if kind == "folder_file":
        folder.write_text("Not a folder", encoding="utf-8")
    elif kind == "folder_symlink":
        other = tmp_path / "other"
        other.mkdir()
        folder.symlink_to(other, target_is_directory=True)
    else:
        folder.mkdir()
        path = folder / "ai-ml.md"
        if kind == "guide_directory":
            path.mkdir()
        else:
            path.symlink_to(tmp_path / "absent-file")
    with pytest.raises(newsletter_collection_instructions.InstructionError):
        source_guides.load_discovery_instructions(directory)


def test_guide_has_official_sources_and_new_team_exception():
    directory = pathlib.Path(
        str(resources.files("newsletter").joinpath("instructions/discovery"))
    )
    source = (directory / "_sources/ai-ml.md").read_text(encoding="utf-8")
    assert "https://proceedings.mlr.press/" in source
    assert "https://papers.nips.cc/" in source
    assert "https://www.ml.cmu.edu/research/" in source
    assert "https://openreview.net/" in source
    assert "新团队" in source and "白名单" in source
    assert "contribution" in source and "evidence_urls" in source
    assert len(source_guides.load_discovery_instructions(directory)) == 8
    project = tomllib.loads(
        (
            pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"
        ).read_text()
    )
    assert (
        "instructions/discovery/_sources/*.md"
        in project["tool"]["setuptools"]["package-data"]["newsletter"]
    )
