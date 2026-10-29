"""Application resource ownership and explicit backend composition.

This is the only place that opens storage, checks dependencies and starts/stops
the worker and the owner console's listener. Request handlers do not construct
providers or own their lifetime.
"""

import asyncio
from collections.abc import AsyncIterator, Callable, Iterator
import contextlib
import logging
import socket

import fastapi
import uvicorn

import newsletter.adapters as adapters
import newsletter.collection.collector as newsletter_collection_collector
import newsletter.collection.instructions as instructions
import newsletter.collection.pipeline as newsletter_collection_pipeline
import newsletter.collection.repository as repository
import newsletter.console_access as console_access
import newsletter.console_api as console_api
import newsletter.console_read as console_read
import newsletter.diagnostics as diagnostics
import newsletter.editor as newsletter_editor
import newsletter.model_client as model_client
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

_LOGGER = logging.getLogger(__name__)
# Every interface: the pod's hostPort reaches the container's own address, not
# its loopback. The listener authenticates each request itself.
CONSOLE_HOST = "0.0.0.0"


class _ConsoleServer(uvicorn.Server):
    """A second server in the service's event loop.

    The engine's server owns the process signals; this one must not replace
    or restore them, so a SIGTERM still drains the engine as before.
    """

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


async def _serve_console(server: _ConsoleServer, sock: socket.socket) -> None:
    # The console must never take the engine down with it: a failed listener
    # is logged and the engine keeps serving.
    try:
        await server.serve(sockets=[sock])
    except (SystemExit, Exception) as error:  # noqa: BLE001
        diagnostics.record_failure(
            _LOGGER, phase="console_listener_failed", error=error
        )
    finally:
        sock.close()


def _start_console(
    settings: newsletter_settings.Settings,
    healthy: Callable[[], bool],
    host: str,
) -> tuple[_ConsoleServer, asyncio.Task[None]] | None:
    """Bind the console's port first, so a conflict is caught and logged."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, settings.console_port))
    except OSError as error:
        sock.close()
        diagnostics.record_failure(
            _LOGGER, phase="console_listener_failed", error=error
        )
        return None
    server = _ConsoleServer(
        uvicorn.Config(
            console_api.create_console_app(
                console_read.ConsoleReader(settings),
                console_access.load_policy(),
                healthy,
            ),
            lifespan="off",
            access_log=False,
            server_header=False,
            proxy_headers=False,
            limit_concurrency=4,
            timeout_keep_alive=5,
            timeout_graceful_shutdown=5,
            # The engine's server configured logging; leave it as it is.
            log_config=None,
        )
    )
    return server, asyncio.create_task(_serve_console(server, sock))


async def _stop_console(
    console: tuple[_ConsoleServer, asyncio.Task[None]] | None,
) -> None:
    if console is None:
        return
    server, task = console
    server.should_exit = True
    await asyncio.wait({task}, timeout=10)
    if not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


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
    """Own dependencies and workers under one exclusive database lifetime.

    The console listener (settings.console_port) starts after storage is
    open and recovered and stops before the worker and the store do.
    """
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
            if settings.mode == "live":
                await store.deployment.recover_model_contexts(
                    model_client.configured_client(settings)
                )
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
            # Live runs execute the frozen topic DAG; mock mode runs the
            # offline fixture pipeline and never contacts a provider.
            live = settings.mode == "live"
            if not live:
                # The legacy collection directions feed only the offline
                # fixture pipeline. Live runs freeze discovery directions via
                # freeze_workflow below, so only mock mode validates these.
                instructions.load_instructions(settings.instructions_dir)
            runs = repository.RunRepository(store)
            runs.recover()
            workflow_state = state.WorkflowState(store)
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
                    editor=newsletter_editor.ModelEditor(
                        model_client.configured_client(settings),
                        model=settings.model,
                        timeout_seconds=settings.collection_timeout_seconds,
                    ),
                    packet_projection=not notion_v2,
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
            console = (
                _start_console(
                    settings,
                    lambda: (
                        not start_worker
                        or (task is not None and not task.done())
                    ),
                    CONSOLE_HOST,
                )
                if settings.console_port
                else None
            )
            try:
                yield
            finally:
                await _stop_console(console)
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
