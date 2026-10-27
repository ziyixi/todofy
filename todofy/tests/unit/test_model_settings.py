"""Saved model route choices, etags and operation identity on real SQLite."""

import asyncio
import dataclasses
import types
import uuid

import model_router_client as models
import pytest
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from tests.unit.host_support import D1, stubbed_pyodide
from todofy.core.owner_ui import UiError

EMAIL = "gemini-3.5-flash-lite"
REPORT = "gemini-3.8-flash"
SOL = "gpt-6.1-sol"


@pytest.fixture
def settings_api(monkeypatch):
    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import model, model_settings

        class Client:
            async def list_models(self):
                return models.ListModelsResponse(
                    models=tuple(models.Model(id=name, configured=True, kind="text") for name in (EMAIL, REPORT, SOL))
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
    assert [model.id for model in result.models] == [EMAIL, REPORT, SOL]


def test_old_saved_route_aliases_normalize_without_rewriting_storage(settings_api):
    module, env = settings_api
    env.DB.db.execute("INSERT INTO model_settings VALUES (1, 'models/sol-6-1', 'models/gemini-report', 7)")
    selected = asyncio.run(module.get(env))
    assert (selected.email_model, selected.report_model, selected.etag) == (SOL, REPORT, "7")
    saved = env.DB.db.execute("SELECT email_model,report_model FROM model_settings").fetchone()
    assert tuple(saved) == ("models/sol-6-1", "models/gemini-report")
    assert module.native_model("gemini-3.7-flash") == REPORT
    assert module.fallback_models(EMAIL) == (REPORT,)
    assert module.fallback_models(REPORT, report=True) == (EMAIL,)
    assert module.fallback_models(SOL) == ()


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
