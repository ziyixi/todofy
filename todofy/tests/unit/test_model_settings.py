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


def test_model_generate_fallbacks_and_error_classification(monkeypatch):
    from todofy.core.vocab import Code

    with stubbed_pyodide(monkeypatch):
        from todofy.runtime import model

        now = model.now_ms()
        env = types.SimpleNamespace()

        # Past deadline immediately returns SUMMARY_FAILED without calling client
        expired = asyncio.run(model.generate(env, system="sys", user="u", deadline_ms=now - 1, model=EMAIL))
        assert not expired.verdict.ok and expired.verdict.code == Code.SUMMARY_FAILED and expired.attempts == 0

        # Fallback from RESOURCE_EXHAUSTED error to a working fallback model
        calls = []

        class FallbackClient:
            async def generate(self, req):
                calls.append(req.model)
                if req.model == EMAIL:
                    raise models.ModelRouterError("RESOURCE_EXHAUSTED")
                return models.Generation(
                    model=req.model,
                    output="ok text",
                    usage=models.Usage(input_tokens=10, output_tokens=5, available=True),
                    error=None,
                )

        monkeypatch.setattr(model, "client", lambda *_a: FallbackClient())
        res = asyncio.run(
            model.generate(
                env,
                system="sys",
                user="u",
                deadline_ms=now + 60_000,
                model=EMAIL,
                fallback_models=(REPORT,),
            )
        )
        assert res.verdict.ok and res.text == "ok text" and res.tokens == 15 and res.attempts == 2
        assert calls == [EMAIL, REPORT]

        # Rejected error (UNAUTHENTICATED) stops immediately without trying fallback
        calls.clear()

        class RejectedClient:
            async def generate(self, req):
                calls.append(req.model)
                raise models.ModelRouterError("UNAUTHENTICATED")

        monkeypatch.setattr(model, "client", lambda *_a: RejectedClient())
        rej = asyncio.run(
            model.generate(
                env,
                system="sys",
                user="u",
                deadline_ms=now + 60_000,
                model=EMAIL,
                fallback_models=(REPORT,),
            )
        )
        assert not rej.verdict.ok and rej.verdict.code == Code.LLM_REQUEST_REJECTED and calls == [EMAIL]

        # Answer-level error classification (MODEL_QUOTA -> LLM_QUOTA, MODEL_AUTH -> LLM_REQUEST_REJECTED)
        class AnswerErrorClient:
            def __init__(self, reason: str) -> None:
                self.reason = reason

            async def generate(self, req):
                return models.Generation(
                    model=req.model,
                    output="",
                    usage=models.Usage(input_tokens=4, output_tokens=0, available=True),
                    error=models.ModelError(reason=self.reason, message="err", retry_after_seconds=12.0),
                )

        monkeypatch.setattr(model, "client", lambda *_a: AnswerErrorClient("MODEL_QUOTA"))
        quota_res = asyncio.run(model.generate(env, system="sys", user="u", deadline_ms=now + 60_000, model=EMAIL))
        assert quota_res.verdict.code == Code.LLM_QUOTA and quota_res.verdict.retry_after == 12.0

        monkeypatch.setattr(model, "client", lambda *_a: AnswerErrorClient("MODEL_AUTH"))
        auth_res = asyncio.run(
            model.generate(
                env, system="sys", user="u", deadline_ms=now + 60_000, model=EMAIL, fallback_models=(REPORT,)
            )
        )
        assert auth_res.verdict.code == Code.LLM_REQUEST_REJECTED and auth_res.attempts == 1
