"""Explicit destination and privacy configuration; no provider access."""

import dataclasses

import pytest

import newsletter.settings as newsletter_settings

MATERIALS = "12345678-1234-1234-1234-123456789abc"
EDITIONS = "22345678-1234-1234-1234-123456789abc"


@pytest.fixture
def live(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        mode="live",
        editor_backend="codex",
        workflow_backend="dag",
        editor_token="e" * 32,
        send_token="s" * 32,
        codex_home=tmp_path / "isolated-auth",
        notion_backend="notion",
        notion_token="synthetic-provider-key",
    )


def test_dual_destinations_need_no_legacy_id(live):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    settings.validate()
    assert settings.notion_v2
    assert not settings.notion_archive_private
    assert "synthetic-provider-key" not in repr(settings)


def test_legacy_destination_remains_supported(live):
    settings = dataclasses.replace(
        live, notion_data_source_id=MATERIALS, workflow_backend="legacy"
    )
    settings.validate()
    assert not settings.notion_v2


def test_dual_database_rejects_legacy_workflow_projection_barriers(live):
    settings = dataclasses.replace(
        live,
        workflow_backend="legacy",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="requires NEWSLETTER_WORKFLOW=dag"):
        settings.validate()


def test_dual_mode_takes_precedence_over_legacy_destination(live):
    settings = dataclasses.replace(
        live,
        notion_data_source_id="unused-legacy-setting",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    settings.validate()
    assert settings.notion_v2


@pytest.mark.parametrize(
    "field",
    ["notion_materials_data_source_id", "notion_editions_data_source_id"],
)
def test_half_configured_dual_mode_does_not_silently_fall_back(live, field):
    settings = dataclasses.replace(
        live, notion_data_source_id=MATERIALS, **{field: EDITIONS}
    )
    with pytest.raises(
        ValueError, match="Set both NOTION_MATERIALS_DATA_SOURCE_ID"
    ):
        settings.validate()


@pytest.mark.parametrize(
    "editions", [MATERIALS, MATERIALS.replace("-", "").upper()]
)
def test_same_destination_is_rejected_in_all_uuid_formats(live, editions):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=editions,
    )
    with pytest.raises(ValueError, match="different data sources"):
        settings.validate()


def test_invalid_uuid_does_not_echo_configured_value(live):
    settings = dataclasses.replace(
        live,
        notion_materials_data_source_id="misplaced-private-key",
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="valid data source IDs") as error:
        settings.validate()
    assert "misplaced-private-key" not in str(error.value)
    assert error.value.__suppress_context__


def test_missing_notion_token_remains_invalid(live):
    settings = dataclasses.replace(
        live,
        notion_token="",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="NOTION_TOKEN"):
        settings.validate()


def test_programmatic_privacy_configuration_rejects_truthy_strings(live):
    settings = dataclasses.replace(
        live, notion_data_source_id=MATERIALS, notion_archive_private="false"
    )
    with pytest.raises(ValueError, match="must be a boolean"):
        settings.validate()


def test_mock_mode_cannot_enable_live_dual_database(live):
    settings = dataclasses.replace(
        live,
        mode="mock",
        editor_backend="mock",
        notion_materials_data_source_id=MATERIALS,
        notion_editions_data_source_id=EDITIONS,
    )
    with pytest.raises(ValueError, match="Mock mode forbids"):
        settings.validate()


def test_dual_settings_read_exact_environment_names(monkeypatch):
    monkeypatch.setenv("NOTION_MATERIALS_DATA_SOURCE_ID", MATERIALS)
    monkeypatch.setenv("NOTION_EDITIONS_DATA_SOURCE_ID", EDITIONS)
    monkeypatch.setenv("NEWSLETTER_NOTION_ARCHIVE_PRIVATE", "true")
    settings = newsletter_settings.Settings.from_env()
    assert settings.notion_v2
    assert settings.notion_materials_data_source_id == MATERIALS
    assert settings.notion_editions_data_source_id == EDITIONS
    assert settings.notion_archive_private is True


@pytest.mark.parametrize(
    "value,expected", [(None, False), ("false", False), ("TRUE", True)]
)
def test_private_archive_requires_explicit_boolean(
    monkeypatch, value, expected
):
    monkeypatch.delenv("NEWSLETTER_NOTION_ARCHIVE_PRIVATE", raising=False)
    if value is not None:
        monkeypatch.setenv("NEWSLETTER_NOTION_ARCHIVE_PRIVATE", value)
    assert (
        newsletter_settings.Settings.from_env().notion_archive_private
        is expected
    )


def test_private_archive_invalid_boolean_is_safe_configuration_error(
    monkeypatch,
):
    monkeypatch.setenv(
        "NEWSLETTER_NOTION_ARCHIVE_PRIVATE", "misplaced-private-key"
    )
    with pytest.raises(
        ValueError, match="NEWSLETTER_NOTION_ARCHIVE_PRIVATE"
    ) as error:
        newsletter_settings.Settings.from_env()
    assert "misplaced-private-key" not in str(error.value)
