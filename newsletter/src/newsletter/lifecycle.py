"""Application resource ownership and explicit backend composition.

This is the only place that opens storage, checks dependencies and starts/stops
the worker. Request handlers do not construct providers or own their lifetime.
"""

import asyncio
from collections.abc import AsyncIterator, Callable
import contextlib
import pathlib
from typing import cast

import fastapi

import newsletter.adapters as adapters
import newsletter.collection.collector as newsletter_collection_collector
import newsletter.collection.instructions as instructions
import newsletter.collection.pipeline as newsletter_collection_pipeline
import newsletter.collection.repository as repository
import newsletter.editor as newsletter_editor
import newsletter.notion_api as notion_api
import newsletter.notion_journal as notion_journal
import newsletter.notion_sync as notion_sync
import newsletter.ownership as ownership
import newsletter.preflight as preflight
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.todofy as newsletter_todofy
import newsletter.worker as newsletter_worker
import newsletter.workflow.pipeline as newsletter_workflow_pipeline
import newsletter.workflow.state as state


@contextlib.asynccontextmanager
async def service_lifespan(
    app: fastapi.FastAPI,
    *,
    settings: newsletter_settings.Settings,
    editor: newsletter_editor.Editor | None = None,
    notion: adapters.NotionAdapter | None = None,
    mail: adapters.MailAdapter | None = None,
    todofy: newsletter_todofy.TodofyAdapter | None = None,
    collector: newsletter_collection_collector.Collector | None = None,
    start_worker: bool = True,
) -> AsyncIterator[None]:
    """Own dependencies and workers under one exclusive database lifetime."""
    with ownership.exclusive_store(settings.data_dir):
        store = newsletter_store.Store(
            settings.data_dir / "newsletter.sqlite3",
            settings.mode,
            settings.max_pending_jobs,
        )
        try:
            store.bind_delivery_target(
                {
                    "backend": settings.mail_backend,
                    "from": settings.from_email,
                    "to": settings.recipient_email,
                }
            )
            store.recover()
            store.deployment.recover()
            # A newly bootstrapped process must stay closed until the release
            # pipeline explicitly verifies/resumes it. A completed same-key
            # receipt does not re-close admission on an ordinary restart.
            if (
                settings.bootstrap_drain_key
                and store.deployment.status()["state"] == "active"
            ):
                store.deployment.begin(settings.bootstrap_drain_key)
            # A process must not advertise readiness with broken enabled
            # dependencies.
            app.state.preflight = await preflight.preflight(
                settings, store=store
            )
            instructions.load_instructions(settings.instructions_dir)
            runs = repository.RunRepository(store)
            runs.recover()
            workflow_state = state.WorkflowState(store)
            # Live runs execute the frozen topic DAG; mock mode runs the
            # offline fixture pipeline and never contacts a provider.
            live = settings.mode == "live"
            if live:
                # Fail startup on malformed graphs or missing instruction
                # resources.
                newsletter_workflow_pipeline.freeze_workflow(
                    settings, workflow_state, "2000-01-01"
                )
            # Every live edition carries a frozen workflow result, so only
            # the offline fixture flow needs a whole-edition editor.
            chosen_editor = editor or (
                newsletter_editor.MockEditor()
                if settings.editor_backend == "mock"
                else None
            )
            # Real Notion writes go through the dual-database sync below. The
            # worker's packet projection only serves the offline fixture.
            notion_v2 = settings.notion_backend == "notion"
            chosen_notion = notion or (
                adapters.FakeNotion(settings.data_dir / "notion")
                if settings.notion_backend == "fake"
                else adapters.DisabledNotion()
            )
            app.state.mail = mail or (
                adapters.FakeMail(settings.data_dir / "outbox")
                if settings.mail_backend == "fake"
                else adapters.Resend(
                    settings.resend_api_key,
                    settings.from_email,
                    settings.recipient_email,
                )
            )
            todofy_factories: dict[
                str, Callable[[], newsletter_todofy.TodofyAdapter]
            ] = {
                "disabled": lambda: newsletter_todofy.DisabledTodofy(),
                "fake": lambda: newsletter_todofy.FakeTodofy(),
                "todofy": lambda: newsletter_todofy.Todofy(
                    settings.todofy_base_url,
                    settings.todofy_user,
                    settings.todofy_password,
                    mode=settings.todofy_mode,
                    top=settings.todofy_top,
                    time_zone=settings.time_zone,
                ),
            }
            pipeline: newsletter_worker.Pipeline = (
                newsletter_workflow_pipeline.DagPipeline(
                    runs,
                    settings.data_dir / "collection-jobs",
                    editor=newsletter_editor.CodexEditor(
                        cast(pathlib.Path, settings.codex_home),
                        model=settings.model,
                        timeout_seconds=settings.collection_timeout_seconds,
                    ),
                )
                if live
                else newsletter_collection_pipeline.CollectionPipeline(
                    runs,
                    collector
                    or newsletter_collection_collector.MockCollector(),
                    settings.data_dir / "collection-jobs",
                    settings.collection_timeout_seconds,
                    settings.max_packets,
                )
            )
            if isinstance(pipeline, newsletter_workflow_pipeline.DagPipeline):
                pipeline.recover()
            worker = newsletter_worker.Worker(
                store,
                chosen_editor,
                chosen_notion,
                settings.data_dir / "editor-jobs",
                settings.job_timeout_seconds,
                todofy=todofy or todofy_factories[settings.todofy_backend](),
                pipeline=pipeline,
                skip_packet_projection=notion_v2,
            )
            app.state.store, app.state.worker = store, worker
            app.state.runs = runs
            app.state.workflow_state = workflow_state
            sync = None
            if notion_v2:
                sync = notion_sync.NotionSync(
                    notion_journal.NotionJournal(
                        store,
                        {
                            "materials": (
                                settings.notion_materials_data_source_id
                            ),
                            "editions": settings.notion_editions_data_source_id,
                            "include_personal": settings.notion_archive_private,
                        },
                    ),
                    notion_api.NotionWorkspace(
                        settings.notion_token,
                        settings.notion_materials_data_source_id,
                        settings.notion_editions_data_source_id,
                    ),
                    include_personal=settings.notion_archive_private,
                )
            app.state.notion_sync = sync
            task = asyncio.create_task(worker.run()) if start_worker else None
            app.state.worker_task = task
            sync_task = (
                asyncio.create_task(sync.run())
                if sync and start_worker
                else None
            )
            app.state.notion_sync_task = sync_task
            try:
                yield
            finally:
                if sync_task:
                    sync_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await sync_task
                if task:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
        finally:
            store.close()
