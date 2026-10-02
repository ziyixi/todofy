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
            # A process must not advertise readiness with broken enabled
            # dependencies.
            app.state.preflight = await preflight.preflight(
                settings, store=store
            )
            instructions.load_instructions(settings.instructions_dir)
            runs = repository.RunRepository(store)
            runs.recover()
            workflow_state = state.WorkflowState(store)
            dag_enabled = (
                settings.workflow_backend == "dag" and settings.mode == "live"
            )
            if dag_enabled:
                # Fail startup on malformed graphs or missing instruction
                # resources.
                newsletter_workflow_pipeline.freeze_workflow(
                    settings, workflow_state, "2000-01-01"
                )
            chosen_editor: newsletter_editor.Editor = editor or (
                newsletter_editor.MockEditor()
                if settings.editor_backend == "mock"
                else newsletter_editor.CodexEditor(
                    codex_home=cast(pathlib.Path, settings.codex_home),
                    model=settings.model,
                )
            )
            notion_factories: dict[
                str, Callable[[], adapters.NotionAdapter]
            ] = {
                "disabled": lambda: adapters.DisabledNotion(),
                "fake": lambda: adapters.FakeNotion(
                    settings.data_dir / "notion"
                ),
                "notion": lambda: adapters.Notion(
                    settings.notion_token, settings.notion_data_source_id
                ),
            }
            notion_v2 = (
                settings.notion_backend == "notion" and settings.notion_v2
            )
            chosen_notion = notion or (
                adapters.DisabledNotion()
                if notion_v2
                else notion_factories[settings.notion_backend]()
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
            research_editor = (
                newsletter_editor.CodexEditor(
                    cast(pathlib.Path, settings.codex_home),
                    model=settings.model,
                    timeout_seconds=settings.collection_timeout_seconds,
                )
                if settings.mode == "live"
                else None
            )
            chosen_collector = collector or (
                newsletter_collection_collector.MockCollector()
                if settings.mode == "mock"
                else newsletter_collection_collector.CodexCollector(
                    cast(newsletter_editor.CodexEditor, research_editor)
                )
            )
            pipeline_args = (
                runs,
                chosen_collector,
                settings.data_dir / "collection-jobs",
                settings.collection_timeout_seconds,
                settings.max_packets,
            )
            pipeline: newsletter_collection_pipeline.CollectionPipeline = (
                newsletter_workflow_pipeline.DagPipeline(
                    *pipeline_args,
                    editor=cast(newsletter_editor.CodexEditor, research_editor),
                    recipe_path=settings.workflow_file,
                )
                if dag_enabled
                else newsletter_collection_pipeline.CollectionPipeline(
                    *pipeline_args
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
