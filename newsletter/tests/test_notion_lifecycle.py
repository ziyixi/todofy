"""V2 composition and operator diagnostics do not run models or send email."""

import asyncio
import dataclasses
import sqlite3

import fastapi
import pytest

import newsletter.adapters as adapters
import newsletter.editor as editor
import newsletter.lifecycle as lifecycle
import newsletter.notion_cli as notion_cli
import newsletter.notion_sync as notion_sync
import newsletter.preflight as preflight
import newsletter.settings as newsletter_settings
import newsletter.store as store
import newsletter.worker as worker
import newsletter.workflow.pipeline as pipeline
import newsletter.workflow.state as state
import newsletter.workflow.story_recipe as story_recipe


@pytest.fixture
def settings(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "live",
        mode="live",
        editor_backend="codex",
        workflow_backend="dag",
        notion_backend="notion",
        notion_token="synthetic-notion-token-for-offline-test",
        notion_materials_data_source_id="11111111-1111-4111-8111-111111111111",
        notion_editions_data_source_id="22222222-2222-4222-8222-222222222222",
        codex_home=tmp_path / "auth",
    )


async def test_consumers_stop_before_store_and_skip_legacy_projection(
    settings, monkeypatch
):
    events = []

    async def checked(*args, **kwargs):
        return preflight.PreflightReport((), ())

    async def idle_worker(self):
        events.append("worker-start")
        try:
            await asyncio.Event().wait()
        finally:
            self.store.db.execute("SELECT 1")
            events.append("worker-stop")

    async def idle_sync(self):
        events.append("sync-start")
        try:
            await asyncio.Event().wait()
        finally:
            self.journal.store.db.execute("SELECT 1")
            events.append("sync-stop")

    monkeypatch.setattr(preflight, "preflight", checked)
    monkeypatch.setattr(worker.Worker, "run", idle_worker)
    monkeypatch.setattr(notion_sync.NotionSync, "run", idle_sync)
    app = fastapi.FastAPI()
    async with lifecycle.service_lifespan(
        app, settings=settings, editor=editor.MockEditor()
    ):
        await asyncio.sleep(0)
        assert events == ["worker-start", "sync-start"]
        assert isinstance(app.state.worker.notion, adapters.DisabledNotion)
        assert app.state.worker.skip_packet_projection
        before = (settings.data_dir / "newsletter.sqlite3").read_bytes()
        assert notion_cli.status(settings.data_dir / "newsletter.sqlite3")[
            "enabled"
        ]
        assert (settings.data_dir / "newsletter.sqlite3").read_bytes() == before
        assert not app.state.store.db.execute("SELECT 1 FROM sends").fetchone()
    assert events == ["worker-start", "sync-start", "sync-stop", "worker-stop"]


async def test_destination_failure_does_not_leave_content_worker_running(
    settings, monkeypatch
):
    async def checked(*args, **kwargs):
        return preflight.PreflightReport((), ())

    async def forbidden(*args, **kwargs):
        pytest.fail("A consumer started before initialization completed")

    monkeypatch.setattr(preflight, "preflight", checked)
    app = fastapi.FastAPI()
    async with lifecycle.service_lifespan(
        app, settings=settings, start_worker=False
    ):
        pass
    monkeypatch.setattr(worker.Worker, "run", forbidden)
    with pytest.raises(ValueError, match="explicit migration"):
        async with lifecycle.service_lifespan(
            app,
            settings=dataclasses.replace(settings, notion_archive_private=True),
        ):
            pytest.fail("Changed audience/privacy was silently adopted")


def test_status_missing_database_never_creates_it(tmp_path):
    path = tmp_path / "absent.sqlite3"
    with pytest.raises(sqlite3.OperationalError):
        notion_cli.status(path)
    assert not path.exists()


def test_legacy_recipe_is_rejected_for_v2_before_freezing(
    settings, tmp_path, monkeypatch
):
    with_store = store.Store(tmp_path / "source.sqlite3", "live")
    try:
        monkeypatch.setattr(
            story_recipe, "is_story_recipe", lambda definition: False
        )
        with pytest.raises(ValueError, match="story publication"):
            pipeline.freeze_workflow(
                settings, state.WorkflowState(with_store), "2026-09-07"
            )
    finally:
        with_store.close()
