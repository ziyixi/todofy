"""Remote context identity and cleanup receipts across uncertain transport."""

import contextlib

import model_router_client as models
import pytest

import newsletter.drain as drain
import newsletter.errors as errors
import newsletter.store as storage
import tests.support.editor as editors


async def test_uncertain_create_keeps_durable_identity_until_remote_close(
    tmp_path, fake_router, monkeypatch
):
    database_path = tmp_path / "newsletter.sqlite3"

    async def lost_create(request):
        raise models.ModelRouterError("UNAVAILABLE")

    monkeypatch.setattr(fake_router, "create_conversation", lost_create)
    fake_router.close_error = models.ModelRouterError("UNAVAILABLE")
    with contextlib.closing(storage.Store(database_path, "live")) as store:
        with (
            store.deployment.activity("model"),
            pytest.raises(errors.EditorError, match="unavailable"),
        ):
            await editors.live_editor(tmp_path).execute(
                "{}", {}, "synthetic", tmp_path / "workspace"
            )
        names = store.db.execute(
            "SELECT name,close_request_id FROM deployment_model_contexts "
            "WHERE state='open'"
        ).fetchall()
        assert len(names) == 1
        store.deployment.begin("release")
        with pytest.raises(drain.DrainError, match="deployment_busy"):
            store.deployment.freeze("release")

    with contextlib.closing(storage.Store(database_path, "live")) as store:
        store.deployment.recover()
        with pytest.raises(drain.DrainError, match="deployment_busy"):
            store.deployment.freeze("release")
        fake_router.close_error = None
        await store.deployment.recover_model_contexts(fake_router)
        store.deployment.recover()
        assert not store.deployment.freeze("release")["busy"]


async def test_open_cleanup_response_cannot_release_drain(
    tmp_path, fake_router, monkeypatch
):
    with contextlib.closing(
        storage.Store(tmp_path / "newsletter.sqlite3", "live")
    ) as store:
        with store.deployment.activity("model"):
            name = "conversations/synthetic-context"
            drain.register_model_context(name)
            drain.mark_uncertain()

        async def still_open(request):
            return models.Conversation(name=request.name, state="open")

        monkeypatch.setattr(fake_router, "close_conversation", still_open)
        with pytest.raises(drain.DrainError, match="model_cleanup_unconfirmed"):
            await store.deployment.recover_model_contexts(fake_router)
        store.deployment.recover()
        store.deployment.begin("release")
        with pytest.raises(drain.DrainError, match="deployment_busy"):
            store.deployment.freeze("release")
