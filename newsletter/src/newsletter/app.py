"""Private ProtoJSON HTTP transport without import-time provider I/O."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
import dataclasses
import functools
import secrets
from typing import Any, cast

import fastapi
import fastapi.responses as responses
import google.protobuf.message as google_protobuf_message
import starlette.middleware.base as base
import starlette.responses as starlette_responses
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.collection.collector as newsletter_collection_collector
import newsletter.collection.instructions as newsletter_collection_instructions
import newsletter.collection.repository as repository
import newsletter.contracts as contracts
import newsletter.delivery as delivery
import newsletter.deployment_api as deployment_api
import newsletter.drain as drain
import newsletter.editor as newsletter_editor
import newsletter.lifecycle as lifecycle
import newsletter.rendering as rendering
import newsletter.settings as newsletter_settings
import newsletter.store as store
import newsletter.todofy as newsletter_todofy
import newsletter.types as types
import newsletter.worker as worker
import newsletter.workflow.definition as definition
import newsletter.workflow.pipeline as newsletter_workflow_pipeline


def create_app(
    settings: newsletter_settings.Settings | None = None,
    *,
    editor: newsletter_editor.Editor | None = None,
    notion: adapters.NotionAdapter | None = None,
    mail: adapters.MailAdapter | None = None,
    todofy: newsletter_todofy.TodofyAdapter | None = None,
    collector: newsletter_collection_collector.Collector | None = None,
    start_worker: bool = True,
) -> fastapi.FastAPI:
    """Assemble HTTP routes; the lifespan alone opens providers and storage.

    Explicit adapters and start_worker=False support isolated offline tests.
    Settings are validated immediately; dependencies are checked on startup.
    """
    settings = settings or newsletter_settings.Settings.from_env()
    settings.validate()
    # macOS system temp ancestors (/var, /tmp) are symlinks. Canonicalize the
    # validated service root before handing isolated paths to the strict editor.
    settings = dataclasses.replace(
        settings, data_dir=settings.data_dir.resolve()
    )

    app = fastapi.FastAPI(
        title="Personal Newsletter",
        version="0.1.0",
        lifespan=functools.partial(
            lifecycle.service_lifespan,
            settings=settings,
            editor=editor,
            notion=notion,
            mail=mail,
            todofy=todofy,
            collector=collector,
            start_worker=start_worker,
        ),
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.get("/healthz")
    async def health() -> responses.JSONResponse:
        return _health(app, settings.mode, start_worker)

    @app.post(
        "/v1/runs", dependencies=[fastapi.Depends(_auth(settings, "editor"))]
    )
    async def start_run(
        request: fastapi.Request,
    ) -> responses.JSONResponse:
        if start_worker and not task_healthy(app):
            raise fastapi.HTTPException(503, "Collection worker is unavailable")
        value = await _body(settings, request, editorial_pb2.StartRunRequest)
        with _store(app).deployment.activity("admission"):
            runs: repository.RunRepository = app.state.runs
            if previous := runs.existing(value):
                pipeline = _worker(app).pipeline
                if isinstance(
                    pipeline, newsletter_workflow_pipeline.DagPipeline
                ):
                    previous = pipeline.receipt(previous["id"])
                return _response(
                    previous,
                    editorial_pb2.CollectionRun,
                    202,
                )
            if settings.mode == "live" and settings.notion_backend != "notion":
                raise fastapi.HTTPException(
                    409, "Full live collection requires Notion persistence"
                )
            try:
                workflow_snapshot = None
                if isinstance(
                    _worker(app).pipeline,
                    newsletter_workflow_pipeline.DagPipeline,
                ):
                    instructions, workflow_snapshot = (
                        newsletter_workflow_pipeline.freeze_workflow(
                            settings,
                            app.state.workflow_state,
                            value["issue_date"],
                        )
                    )
                else:
                    instructions = (
                        newsletter_collection_instructions.load_instructions(
                            settings.instructions_dir
                        )
                    )
            except (
                newsletter_collection_instructions.InstructionError,
                definition.DefinitionError,
                OSError,
                ValueError,
            ):
                raise fastapi.HTTPException(
                    503, "Collection instructions are invalid"
                ) from None
            run = runs.start(
                value, instructions, workflow_snapshot=workflow_snapshot
            )
            _worker(app).wake.set()
            return _response(run, editorial_pb2.CollectionRun, 202)

    @app.get(
        "/v1/runs/{run_id}",
        dependencies=[fastapi.Depends(_auth(settings, "editor"))],
    )
    async def get_run(run_id: str) -> responses.JSONResponse:
        contracts.validate_request(
            contracts.parse_message(
                {"id": run_id},
                editorial_pb2.GetRunRequest,
            )
        )
        pipeline = _worker(app).pipeline
        value = (
            pipeline.receipt(run_id)
            if isinstance(pipeline, newsletter_workflow_pipeline.DagPipeline)
            else app.state.runs.get(run_id)
        )
        return _response(value, editorial_pb2.CollectionRun)

    @app.get(
        "/v1/editions/{edition_id}",
        dependencies=[fastapi.Depends(_auth(settings, "editor", "send"))],
    )
    async def get_edition(edition_id: str) -> responses.JSONResponse:
        contracts.validate_request(
            contracts.parse_message(
                {"id": edition_id},
                editorial_pb2.GetEditionRequest,
            )
        )
        return _response(
            _store(app).get(edition_id),
            editorial_pb2.Edition,
        )

    @app.get(
        "/v1/editions/{edition_id}/preview",
        dependencies=[fastapi.Depends(_auth(settings, "editor", "send"))],
    )
    async def preview(edition_id: str) -> responses.HTMLResponse:
        edition = _store(app).get(edition_id)
        if edition["state"] != "ready":
            raise store.StoreError("conflict", "Preview is not ready")
        return responses.HTMLResponse(
            rendering.preview_html(edition["rendered"])
        )

    @app.post(
        "/v1/editions/{edition_id}/send",
        dependencies=[fastapi.Depends(_auth(settings, "send"))],
    )
    async def send(
        edition_id: str, request: fastapi.Request
    ) -> responses.JSONResponse:
        """Send only the explicitly approved frozen normal edition."""
        value = await _approval(settings, edition_id, request)
        edition = await delivery.send_edition(
            _store(app),
            _mail(app),
            value,
            real_delivery=settings.mail_backend == "resend",
        )
        return _response(edition, editorial_pb2.Edition)

    deployment_api.register(app, _auth(settings, "send"))
    app.exception_handler(drain.DrainError)(deployment_api.known_error)
    app.middleware("http")(_private_responses)
    app.exception_handler(contracts.ContractError)(_known_error)
    app.exception_handler(store.StoreError)(_known_error)
    return app


def _store(app: fastapi.FastAPI) -> store.Store:
    # Starlette State is dynamic; service_lifespan owns these concrete
    # instances.
    return cast(store.Store, app.state.store)


async def _approval(
    settings: newsletter_settings.Settings,
    edition_id: str,
    request: fastapi.Request,
) -> types.Payload:
    value = await _body(settings, request, editorial_pb2.SendEditionRequest)
    if value["id"] != edition_id:
        raise store.StoreError(
            "conflict", "Body ID must match the resource path"
        )
    if request.headers.getlist("x-newsletter-verification-after"):
        raise store.StoreError(
            "invalid_argument", "Verification requires the maintenance CLI"
        )
    return value


def _worker(app: fastapi.FastAPI) -> worker.Worker:
    return cast(worker.Worker, app.state.worker)


def _mail(app: fastapi.FastAPI) -> adapters.MailAdapter:
    return cast(adapters.MailAdapter, app.state.mail)


def task_healthy(app: fastapi.FastAPI) -> bool:
    """Return whether the lifespan-owned worker can still accept queued work."""
    # The lifespan owns the worker; no queue can be silently accepted after it
    # dies.
    task = cast(
        asyncio.Task[None] | None, getattr(app.state, "worker_task", None)
    )
    return task is not None and not task.done()


def _health(
    app: fastapi.FastAPI, mode: str, start_worker: bool
) -> responses.JSONResponse:
    worker_ok = not start_worker or task_healthy(app)
    return responses.JSONResponse(
        {"status": "ok" if worker_ok else "degraded", "mode": mode},
        status_code=200 if worker_ok else 503,
    )


def _auth(
    settings: newsletter_settings.Settings,
    *roles: types.Role,
) -> Callable[[fastapi.Request], Awaitable[None]]:
    async def check(request: fastapi.Request) -> None:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        accepted = [getattr(settings, f"{role}_token") for role in roles]
        if not any(
            secrets.compare_digest(token.encode(), value.encode())
            for value in accepted
        ):
            raise fastapi.HTTPException(
                401,
                "Valid bearer token required",
                headers={"WWW-Authenticate": "Bearer"},
            )

    return check


async def _body(
    settings: newsletter_settings.Settings,
    request: fastapi.Request,
    message_type: type[google_protobuf_message.Message],
) -> types.Payload:
    if (
        request.headers.get("content-type", "").split(";")[0].strip()
        != "application/json"
    ):
        raise fastapi.HTTPException(415, "Use application/json ProtoJSON")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > settings.max_body_bytes:
            raise fastapi.HTTPException(413, "Request body exceeds limit")
    message = contracts.parse_message(bytes(data), message_type)
    contracts.validate_request(message)
    return contracts.to_dict(message)


def _response(
    value: Mapping[str, Any],
    message_type: type[google_protobuf_message.Message],
    status: int = 200,
) -> responses.JSONResponse:
    return responses.JSONResponse(
        contracts.to_dict(contracts.parse_message(value, message_type)),
        status_code=status,
    )


async def _private_responses(
    request: fastapi.Request,
    call_next: base.RequestResponseEndpoint,
) -> starlette_responses.Response:
    result = await call_next(request)
    result.headers["Cache-Control"] = "no-store"
    result.headers["X-Content-Type-Options"] = "nosniff"
    result.headers["Referrer-Policy"] = "no-referrer"
    result.headers["Content-Security-Policy"] = (
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; "
        "sandbox allow-popups"
    )
    return result


async def _known_error(
    request: fastapi.Request,
    exc: contracts.ContractError | store.StoreError,
) -> responses.JSONResponse:
    code = exc.code.lower()
    status = {
        "not_found": 404,
        "conflict": 409,
        "busy": 429,
        "too_large": 413,
    }.get(code, 400)
    return responses.JSONResponse(
        {"error": {"code": code, "message": str(exc)}}, status_code=status
    )
