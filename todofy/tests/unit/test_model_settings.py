"""Saved model route choices, etags and operation identity on real SQLite."""

import asyncio
import dataclasses
import sqlite3
import types
import uuid
from pathlib import Path

import model_router_client as models
import pytest
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from tests.unit.host_support import D1, stubbed_pyodide
from todofy.core.owner_ui import UiError

EMAIL = "gemini-3.5-flash-lite"
REPORT = "gemini-3.8-flash"
SOL = "gpt-6.1-sol"
API_SOL = "openai/gpt-6.1-sol"
MIGRATIONS = sorted((Path(__file__).parents[2] / "migrations").glob("*.sql"))
REWRITE = MIGRATIONS[0].parent / "0017_native_model_ids.sql"


@pytest.fixture
def settings_api(monkeypatch):
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import model, model_settings

        class Client:
            async def list_models(self):
                return models.ListModelsResponse(
                    models=(
                        models.Model(id=EMAIL, configured=True, kind="text", provider="google"),
                        models.Model(id=REPORT, configured=True, kind="text", provider="google"),
                        models.Model(id=SOL, configured=True, kind="text", provider="codex"),
                        models.Model(id=API_SOL, configured=True, kind="text", provider="openai"),
                        models.Model(id="openai/gpt-6-astra", configured=False, kind="text", provider="openai"),
                    )
                )

        monkeypatch.setattr(model, "client", lambda *_args: Client())
        environment = types.SimpleNamespace(DB=D1())
        yield model_settings, environment


def request(settings, *, mask=None):
    value = pb.UpdateModelSettingsRequest(
        settings=settings, request_id=str(uuid.uuid4()), update_mask=mask, etag=settings.etag
    )
    return from_wire(pb.UpdateModelSettingsRequest, to_wire(value), strict=True).message


def test_initial_route_choices_and_configured_catalog(settings_api):
    module, env = settings_api
    result = asyncio.run(module.catalog(env))
    assert (result.settings.email_model, result.settings.report_model, result.settings.etag) == (EMAIL, REPORT, "0")
    assert [model.id for model in result.models] == [EMAIL, REPORT, SOL, API_SOL, "openai/gpt-6-astra"]


@pytest.mark.parametrize(
    ("saved", "native"),
    [
        (("models/sol-6-1", "models/gemini-report"), (SOL, REPORT)),
        (("models/gemini-email", "gemini-3.7-flash"), (EMAIL, REPORT)),
    ],
)
def test_migration_rewrites_old_saved_route_names_once(saved, native):
    db = sqlite3.connect(":memory:")
    for migration in MIGRATIONS[: MIGRATIONS.index(REWRITE)]:
        db.executescript(migration.read_text())
    db.execute("INSERT INTO model_settings VALUES (1, ?, ?, 7)", saved)
    db.executescript(REWRITE.read_text())
    assert db.execute("SELECT email_model,report_model,version FROM model_settings").fetchone() == (*native, 7)
    db.executescript(REWRITE.read_text())
    assert db.execute("SELECT email_model,report_model FROM model_settings").fetchone() == native


def test_only_the_two_gemini_choices_fall_back_to_each_other(settings_api):
    module, _ = settings_api
    assert module.fallback_models(EMAIL) == (REPORT,)
    assert module.fallback_models(REPORT, report=True) == (EMAIL,)
    assert module.fallback_models(SOL) == ()
    assert module.fallback_models(API_SOL) == ()


def test_update_replays_identical_operation_and_rejects_reused_identity(settings_api):
    module, env = settings_api
    current = asyncio.run(module.get(env))
    operation = request(dataclasses.replace(current, email_model=SOL))
    changed = asyncio.run(module.update(env, "owner", operation))
    assert changed.email_model == SOL and changed.etag == "1"
    assert asyncio.run(module.update(env, "owner", operation)) == changed
    with pytest.raises(UiError, match="BAD_REQUEST"):
        asyncio.run(module.update(env, "owner", dataclasses.replace(operation, settings=current)))


def test_masked_update_changes_only_the_requested_choice(settings_api):
    module, env = settings_api
    current = asyncio.run(module.get(env))
    result = asyncio.run(
        module.update(
            env,
            "owner",
            request(dataclasses.replace(current, email_model=SOL, report_model=SOL), mask=("email_model",)),
        )
    )
    assert (result.email_model, result.report_model) == (SOL, REPORT)


def test_stale_etag_and_unconfigured_model_are_rejected(settings_api):
    module, env = settings_api
    current = asyncio.run(module.get(env))
    asyncio.run(module.update(env, "owner", request(dataclasses.replace(current, email_model=SOL))))
    with pytest.raises(UiError, match="ETAG_MISMATCH"):
        asyncio.run(module.update(env, "owner", request(current)))
    updated = asyncio.run(module.get(env))
    with pytest.raises(UiError, match="BAD_REQUEST"):
        asyncio.run(
            module.update(env, "owner", request(dataclasses.replace(updated, report_model="models/not-configured")))
        )


def test_api_and_subscription_routes_persist_independently(settings_api):
    module, env = settings_api
    current = asyncio.run(module.get(env))
    changed = asyncio.run(
        module.update(env, "owner", request(dataclasses.replace(current, email_model=SOL, report_model=API_SOL)))
    )
    assert asyncio.run(module.get(env)) == changed
    assert (changed.email_model, changed.report_model) == (SOL, API_SOL)
    result = asyncio.run(module.catalog(env))
    assert {item.id: item.provider for item in result.models if item.id in {SOL, API_SOL}} == {
        SOL: "codex",
        API_SOL: "openai",
    }
    with pytest.raises(UiError, match="BAD_REQUEST"):
        asyncio.run(
            module.update(env, "owner", request(dataclasses.replace(changed, report_model="openai/gpt-6-astra")))
        )
