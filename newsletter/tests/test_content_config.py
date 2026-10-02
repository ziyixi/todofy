"""Test config transactions and run isolation without providers or mail."""

import copy
import json

import pytest

import newsletter.collection.repository as repository
import newsletter.config_cli as config_cli
import newsletter.content_config as content_config
import newsletter.contracts as contracts
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.workflow.pipeline as pipeline
import newsletter.workflow.state as newsletter_workflow_state


@pytest.fixture
def baseline():
    return content_config.packaged_snapshot()


def resign(value):
    value["digest"] = contracts.content_hash(
        {key: value[key] for key in ("schema_version", "revision", "files")}
    )
    return value


def test_baseline_has_news_first_budget_and_all_eight_retrievals(baseline):
    assert baseline["editorial"] == {
        "max_public_items": 6,
        "max_research_items": 1,
        "max_deep": 1,
        "max_research_candidates": 10,
    }
    assert len(content_config.config_instructions(baseline["files"])) == 8
    assert content_config.validate_snapshot(baseline) == baseline
    assert len(json.dumps(baseline).encode()) < 768_000


@pytest.mark.parametrize(
    "name,value",
    [
        ("../policy/editorial.md", "invalid"),
        (".env", "secret"),
        ("discovery/../bad.md", "bad"),
        ("discovery/x.py", "pass"),
        ("templates/extra.html", "bad"),
        ("prompts/selection.md", "\x00invalid"),
        ("templates/edition.html.j2", "<script>alert(1)</script>"),
        ("editorial.yaml", "max_public_items: true"),
        ("editorial.yaml", "!!python/object:builtins.exec {}"),
        ("policy/editorial.md", "a" * 100_001),
    ],
)
def test_untrusted_files_fail_even_when_digest_is_valid(baseline, name, value):
    baseline["files"][name] = value
    with pytest.raises(content_config.ContentConfigError):
        content_config.validate_snapshot(resign(baseline))


@pytest.mark.parametrize(
    "field,value",
    [
        ("revision", "main"),
        ("schema_version", True),
        ("schema_version", 2),
        ("digest", "0" * 64),
        ("editorial", {"max_public_items": 6}),
    ],
)
def test_invalid_manifest_rejected(baseline, field, value):
    baseline[field] = value
    with pytest.raises(content_config.ContentConfigError):
        content_config.validate_snapshot(baseline)


def test_metadata_is_recomputed_not_trusted(baseline):
    baseline["editorial"]["max_research_items"] = 5
    with pytest.raises(content_config.ContentConfigError):
        content_config.validate_snapshot(baseline)


def test_duplicate_yaml_fields_rejected(baseline):
    text = baseline["files"]["editorial.yaml"]
    baseline["files"]["editorial.yaml"] = text + "max_public_items: 6\n"
    with pytest.raises(content_config.ContentConfigError):
        content_config.validate_snapshot(resign(baseline))


def test_provenance_changes_digest_even_for_identical_files(baseline):
    other = content_config.build_snapshot(baseline["files"], "b" * 40)
    assert other["digest"] != baseline["digest"]


def test_reject_missing_baseline_without_silent_packaged_fallback(tmp_path):
    with pytest.raises(content_config.ContentConfigError):
        content_config.load_active(tmp_path)


def test_failed_validation_and_failed_activation_keep_old_release(
    tmp_path, baseline, monkeypatch
):
    content_config.install_snapshot(tmp_path, baseline)
    newer = content_config.build_snapshot(baseline["files"], "b" * 40)
    invalid = copy.deepcopy(newer)
    invalid["digest"] = "0" * 64
    with pytest.raises(content_config.ContentConfigError):
        content_config.install_snapshot(tmp_path, invalid)
    original = content_config._atomic_json

    def fail_pointer(path, value):
        if path.name == "active.json":
            raise OSError("simulated atomic activation failure")
        original(path, value)

    monkeypatch.setattr(content_config, "_atomic_json", fail_pointer)
    with pytest.raises(OSError, match="simulated atomic activation failure"):
        content_config.install_snapshot(tmp_path, newer)
    assert content_config.load_active(tmp_path) == baseline
    assert (
        content_config.read_snapshot(
            tmp_path / "releases" / newer["digest"] / "bundle.json"
        )
        == newer
    )


def test_same_version_is_no_write_and_returns_owned_copy(
    tmp_path, baseline, monkeypatch
):
    content_config.install_snapshot(tmp_path, baseline)

    def fail(*args):
        raise AssertionError("same revision must not be rewritten")

    monkeypatch.setattr(content_config, "_atomic_json", fail)
    content_config.install_snapshot(tmp_path, baseline)
    loaded = content_config.load_active(tmp_path)
    loaded["files"]["policy/editorial.md"] = "mutated"
    assert content_config.load_active(tmp_path) == baseline


@pytest.mark.parametrize(
    "target", ["root", "releases", "release", "bundle", "pointer"]
)
def test_symlink_state_is_never_followed(tmp_path, baseline, target):
    root = tmp_path / "config"
    content_config.install_snapshot(root, baseline)
    paths = {
        "root": root,
        "releases": root / "releases",
        "release": root / "releases" / baseline["digest"],
        "bundle": root / "releases" / baseline["digest"] / "bundle.json",
        "pointer": root / "active.json",
    }
    path = paths[target]
    original = tmp_path / "moved"
    path.rename(original)
    path.symlink_to(original, target_is_directory=original.is_dir())
    with pytest.raises(content_config.ContentConfigError):
        content_config.load_active(root)


def test_duplicate_json_key_cannot_hide_modified_provenance(tmp_path, baseline):
    path = tmp_path / "bundle.json"
    raw = json.dumps(baseline)
    path.write_text('{"revision":"hidden",' + raw[1:])
    with pytest.raises(content_config.ContentConfigError):
        content_config.read_snapshot(path)


def test_frozen_run_keeps_whole_config_a_while_next_run_gets_b(
    tmp_path, baseline
):
    root = tmp_path / "config"
    content_config.install_snapshot(root, baseline)
    store = newsletter_store.Store(tmp_path / "state.sqlite3", "mock")
    try:
        state = newsletter_workflow_state.WorkflowState(store)
        settings = newsletter_settings.Settings(
            workflow_backend="dag",
            content_config_dir=root,
            workflow_file=tmp_path / "ignored.yml",
            discovery_dir=tmp_path / "ignored",
        )
        instructions, snapshot = pipeline.freeze_workflow(
            settings, state, "2026-09-08"
        )
        assert snapshot["inputs"]["content_config"] == baseline
        runs = repository.RunRepository(store)
        request = {
            "request_key": "config-isolation",
            "issue_date": "2026-09-08",
        }
        run = runs.start(request, instructions, workflow_snapshot=snapshot)
        files = dict(baseline["files"])
        files["discovery/02-science.md"] += "\nNew configuration direction."
        files["policy/editorial.md"] += "\nNew edition policy."
        files["templates/edition.html.j2"] = files[
            "templates/edition.html.j2"
        ].replace("THE DAILY BRIEF", "NEXT DAILY BRIEF")
        newer = content_config.build_snapshot(files, "b" * 40)
        content_config.install_snapshot(root, newer)
        next_instructions, next_snapshot = pipeline.freeze_workflow(
            settings, state, "2026-09-09"
        )
        assert next_snapshot["inputs"]["content_config"] == newer
        assert next_instructions != instructions
        assert runs.workflow_snapshot(run["id"]) == snapshot
        assert (
            runs.start(request, instructions, workflow_snapshot=snapshot)["id"]
            == run["id"]
        )
        assert runs.workflow_snapshot(run["id"]) == snapshot
        assert set(snapshot["inputs"]["content_config"]) == {
            "schema_version",
            "revision",
            "digest",
            "files",
            "editorial",
        }
    finally:
        store.close()


def test_no_config_remains_legacy_and_settings_reads_only_directory(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(
        "NEWSLETTER_CONTENT_CONFIG_DIR", str(tmp_path / "config")
    )
    assert (
        newsletter_settings.Settings.from_env().content_config_dir
        == tmp_path / "config"
    )
    with pytest.raises(ValueError, match="requires NEWSLETTER_WORKFLOW=dag"):
        newsletter_settings.Settings(content_config_dir=tmp_path).validate()
    store = newsletter_store.Store(tmp_path / "state.sqlite3", "mock")
    try:
        _, snapshot = pipeline.freeze_workflow(
            newsletter_settings.Settings(),
            newsletter_workflow_state.WorkflowState(store),
            "2026-09-08",
        )
        assert "content_config" not in snapshot["inputs"]
    finally:
        store.close()


def test_offline_cli_build_and_validate_do_not_touch_business_state(
    tmp_path, baseline, capsys
):
    source = tmp_path / "source"
    for name, value in baseline["files"].items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    output = tmp_path / "bundle.json"
    assert (
        config_cli.main(
            [
                "build",
                "--source",
                str(source),
                "--revision",
                "a" * 40,
                "--output",
                str(output),
            ]
        )
        == 0
    )
    assert config_cli.main(["validate", "--bundle", str(output)]) == 0
    assert content_config.read_snapshot(
        output
    ) == content_config.build_directory(source, "a" * 40)
    (source / ".env").write_text("SYNTHETIC_TOKEN=never-print-this")
    assert (
        config_cli.main(
            [
                "build",
                "--source",
                str(source),
                "--revision",
                "a" * 40,
                "--output",
                str(output),
            ]
        )
        == 1
    )
    assert "never-print-this" not in capsys.readouterr().err
    assert not list(tmp_path.glob("*.sqlite*"))
