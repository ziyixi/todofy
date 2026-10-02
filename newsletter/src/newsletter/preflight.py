"""Startup checks without generation, projection, or email sending.

Only enabled providers are contacted. Core runtime and configuration failures
stop startup; temporary Notion/Todofy outages are reported as degraded checks.
A successful read is not evidence of write permission, future model/tool
availability, or email delivery. Provider responses and credentials never appear
in the returned report or safe failure messages.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import dataclasses
import hashlib
import importlib.metadata as importlib_metadata
import importlib.resources as resources
import json
import logging
import os
import pathlib
import re
import sqlite3
import sys
import tempfile
import types
from typing import cast, TYPE_CHECKING
import uuid

import httpx
import ziyixi_protos.newsletter.editorial_pb2 as editorial_pb2

import newsletter.adapters as adapters
import newsletter.charts as charts
import newsletter.codex_runtime as codex_runtime
import newsletter.diagnostics as diagnostics
import newsletter.notion_api as notion_api
import newsletter.rendering as rendering
import newsletter.schema_compat as schema_compat
import newsletter.settings as newsletter_settings
import newsletter.todofy as todofy
import newsletter.types as newsletter_types

if TYPE_CHECKING:
    import newsletter.store as newsletter_store

HTTP_TIMEOUT = 15.0
CODEX_TIMEOUT = 45.0
MAX_RESPONSE_BYTES = 512 * 1024
logger = logging.getLogger(__name__)


class PreflightError(RuntimeError):
    """Stable, secret-free error code that excludes upstream exception text."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclasses.dataclass(frozen=True)
class PreflightReport:
    """Completed checks and explicit limits of a non-writing startup probe."""

    checks: tuple[str, ...]
    limitations: tuple[str, ...]


def _check_storage(
    settings: newsletter_settings.Settings, store: newsletter_store.Store | None
) -> None:
    directory = settings.data_dir.resolve()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Exercise writes/WAL in the actual mounted directory without touching any
    # newsletter records. Temporary files are closed and removed on every path.
    with (
        tempfile.TemporaryDirectory(
            prefix=".preflight-storage-", dir=directory
        ) as temporary,
        contextlib.closing(
            sqlite3.connect(pathlib.Path(temporary) / "probe.sqlite3")
        ) as probe,
    ):
        if probe.execute("PRAGMA journal_mode=WAL").fetchone() != ("wal",):
            raise PreflightError("STORAGE_WAL_UNAVAILABLE")
        probe.execute("CREATE TABLE probe (value INTEGER NOT NULL)")
        probe.execute("INSERT INTO probe VALUES (1)")
        probe.commit()
        if probe.execute("SELECT value FROM probe").fetchone() != (1,):
            raise PreflightError("STORAGE_WRITE_FAILED")
    if store is not None:
        with store.lock:
            result = store.db.execute("PRAGMA quick_check(1)").fetchall()
        if len(result) != 1 or result[0][0] != "ok":
            raise PreflightError("STORAGE_INTEGRITY_FAILED")


def check_proto_dependency() -> None:
    """Check the installed public wheel without a sibling checkout or protoc."""
    installed = importlib_metadata.distribution("ziyixi-protos")
    module = installed.locate_file("ziyixi_protos/newsletter/editorial_pb2.py")
    if (
        pathlib.Path(editorial_pb2.__file__).resolve()
        != pathlib.Path(str(module)).resolve()
    ):
        raise PreflightError("PROTO_SOURCE_INVALID")
    generated = resources.files("ziyixi_protos.newsletter")
    manifest = json.loads(
        generated.joinpath("provenance.json").read_text(encoding="utf-8")
    )
    if not isinstance(manifest, dict):
        raise PreflightError("PROTO_SOURCE_INVALID")
    expected = {
        "descriptor_sha256": hashlib.sha256(
            editorial_pb2.DESCRIPTOR.serialized_pb
        ).hexdigest(),
        "generated_sha256": hashlib.sha256(
            generated.joinpath("editorial_pb2.py").read_bytes()
        ).hexdigest(),
        "stubs_sha256": hashlib.sha256(
            generated.joinpath("editorial_pb2.pyi").read_bytes()
        ).hexdigest(),
    }
    if any(manifest.get(key) != digest for key, digest in expected.items()):
        raise PreflightError("PROTO_INTEGRITY_FAILED")
    if (
        manifest.get("source_repository") != "https://github.com/ziyixi/protos"
        or manifest.get("source_path") != "proto/newsletter/editorial.proto"
        or not isinstance(manifest.get("source_commit"), str)
        or not re.fullmatch(r"[a-f0-9]{40}", manifest["source_commit"])
        or not isinstance(manifest.get("source_sha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", manifest["source_sha256"])
    ):
        raise PreflightError("PROTO_SOURCE_INVALID")
    if manifest.get("package_version") != installed.version:
        raise PreflightError("PROTO_VERSION_MISMATCH")


def _check_resources() -> None:
    if sys.version_info[:2] != (3, 12):
        raise PreflightError("PYTHON_VERSION_UNSUPPORTED")
    # Read pins from the installed application's own metadata, not another
    # hand-maintained dependency list. Optional Codex is checked when enabled.
    declared = importlib_metadata.distribution("personal-newsletter").requires
    if not declared:
        raise PreflightError("PACKAGE_METADATA_UNAVAILABLE")
    for requirement in declared:
        pin, _, marker = requirement.partition(";")
        if marker.strip() in {'extra == "codex"', "extra == 'codex'"}:
            continue
        match = re.fullmatch(
            r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)", pin.strip()
        )
        if (
            marker
            or match is None
            or importlib_metadata.version(match[1]) != match[2]
        ):
            raise PreflightError("DEPENDENCY_VERSION_MISMATCH")
    check_proto_dependency()
    package = resources.files("newsletter")
    for filename in ("editorial.md", "story-editorial.md", "reader-profile.md"):
        if (
            not package.joinpath("policy", filename)
            .read_text(encoding="utf-8")
            .strip()
        ):
            raise PreflightError("EDITOR_POLICY_UNAVAILABLE")
    rendering.load_template()
    font = charts.load_font(24)
    glyphs = [bytes(font.getmask(character)) for character in ("中", "文")]
    if not all(any(glyph) for glyph in glyphs) or glyphs[0] == glyphs[1]:
        raise PreflightError("CJK_FONT_UNAVAILABLE")
    # Exercise CJK fonts, FreeType, and PNG encoding without saving a file.
    chart = charts.render_chart_png(
        {
            "kind": "bar",
            "metric": "启动检查",
            "unit": "测试单位",
            "period": "offline",
            "points": [{"label": "测试", "decimal_value": "1"}],
        },
        True,
    )
    if not chart.startswith(b"\x89PNG\r\n\x1a\n"):
        raise PreflightError("RENDERER_UNAVAILABLE")


def _runtime_files() -> tuple[pathlib.Path, pathlib.Path]:
    # Mock startup must not require the optional live Codex runtime package.
    import codex_cli_bin  # type: ignore[import-untyped]  # noqa: PLC0415

    if (
        importlib_metadata.version("openai-codex") != codex_runtime.SDK_VERSION
        or importlib_metadata.version("openai-codex-cli-bin")
        != codex_runtime.SDK_VERSION
    ):
        raise PreflightError("CODEX_VERSION_MISMATCH")
    executable = pathlib.Path(codex_cli_bin.bundled_codex_path())
    host = executable.with_name("codex-code-mode-host")
    metadata = json.loads(
        executable.parent.parent.joinpath("codex-package.json").read_text()
    )
    if metadata.get("version") != codex_runtime.SDK_VERSION:
        raise PreflightError("CODEX_VERSION_MISMATCH")
    installed = importlib_metadata.distribution("openai-codex-cli-bin")
    records = {str(record): record for record in installed.files or ()}
    for binary in (executable, host):
        if (
            binary.is_symlink()
            or not binary.is_file()
            or not os.access(binary, os.X_OK)
        ):
            raise PreflightError("CODEX_EXECUTABLE_UNAVAILABLE")
        record = records.get("codex_cli_bin/bin/" + binary.name)
        if (
            record is None
            or record.hash is None
            or record.hash.mode != "sha256"
        ):
            raise PreflightError("CODEX_INTEGRITY_FAILED")
        with binary.open("rb") as stream:
            digest = base64.urlsafe_b64encode(
                hashlib.file_digest(stream, "sha256").digest()
            )
        if (
            digest.decode().rstrip("=") != record.hash.value
            or binary.stat().st_size != record.size
        ):
            raise PreflightError("CODEX_INTEGRITY_FAILED")
    return executable, host


async def _host_executable(host: pathlib.Path, workspace: pathlib.Path) -> None:
    # --help exits before hosting tools. An exact, non-secret environment
    # excludes service keys, auth homes, proxies, and injected originators.
    process = await asyncio.create_subprocess_exec(
        str(host),
        "--help",
        cwd=workspace,
        env={
            "PATH": os.defpath,
            "HOME": str(workspace),
            "TMPDIR": str(workspace),
        },
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with asyncio.timeout(5):
            if await process.wait() != 0:
                raise PreflightError("CODEX_HOST_UNAVAILABLE")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def _check_codex(
    settings: newsletter_settings.Settings, sdk: types.ModuleType | None
) -> None:
    # Only the live backend requires the optional SDK and response schema.
    import openai_codex.generated.v2_all as v2_all  # noqa: PLC0415

    _, host = _runtime_files()
    sdk = sdk or codex_runtime.load_sdk()
    with tempfile.TemporaryDirectory(
        prefix=".preflight-codex-", dir=settings.data_dir
    ) as name:
        workspace = pathlib.Path(name).resolve()
        home = codex_runtime.check_codex_home(
            cast(pathlib.Path, settings.codex_home), workspace
        )
        await _host_executable(host, workspace)
        overrides = codex_runtime.runtime_overrides(home)
        client = sdk.AsyncCodex(
            sdk.CodexConfig(
                cwd=str(workspace),
                env=codex_runtime.runtime_env(home),
                config_overrides=overrides,
                launch_args_override=codex_runtime.launch_args(overrides),
                client_name="newsletter_preflight",
            )
        )
        try:
            async with asyncio.timeout(CODEX_TIMEOUT):
                await client.__aenter__()
                codex_runtime.check_codex_home(home, workspace)
                await codex_runtime.assert_no_skills(client, workspace, home)
                account = await client.account(refresh_token=True)
                if (
                    account.account is None
                    or account.account.root.type != "chatgpt"
                ):
                    raise PreflightError("CODEX_CHATGPT_AUTH_REQUIRED")
                cursor = None
                seen = set()
                for _ in range(20):
                    params: newsletter_types.Payload = {
                        "limit": 100,
                        "includeHidden": True,
                    }
                    if cursor is not None:
                        params["cursor"] = cursor
                    # SDK 0.156.1's public models() omits pagination parameters.
                    result = await client._client.request(  # noqa: SLF001
                        "model/list",
                        params,
                        response_model=v2_all.ModelListResponse,
                    )
                    if any(
                        model.model == settings.model for model in result.data
                    ):
                        return
                    cursor = result.next_cursor
                    if cursor is None:
                        raise PreflightError("CODEX_MODEL_UNAVAILABLE")
                    if cursor in seen:
                        raise PreflightError("CODEX_MODEL_LIST_INVALID")
                    seen.add(cursor)
                raise PreflightError("CODEX_MODEL_LIST_INVALID")
        finally:
            await asyncio.wait_for(client.close(), timeout=3)


async def _get_json(
    url: str,
    *,
    headers: dict[str, str] | None,
    transport: httpx.AsyncBaseTransport | None,
    provider: str,
) -> newsletter_types.Payload:
    async with asyncio.timeout(HTTP_TIMEOUT):
        async with httpx.AsyncClient(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=HTTP_TIMEOUT,
            headers={"Accept": "application/json", **(headers or {})},
        ) as client:
            async with client.stream("GET", url) as response:
                if response.status_code in {401, 403}:
                    raise PreflightError(provider + "_AUTH_FAILED")
                if (
                    response.status_code == 429
                    or 500 <= response.status_code < 600
                ):
                    raise PreflightError(provider + "_TEMPORARILY_UNAVAILABLE")
                if response.status_code != 200:
                    raise PreflightError(provider + "_UNAVAILABLE")
                if (
                    response.headers.get("content-type", "")
                    .split(";", 1)[0]
                    .strip()
                    != "application/json"
                ):
                    raise PreflightError(provider + "_INVALID_RESPONSE")
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise PreflightError(provider + "_INVALID_RESPONSE")
                    content.extend(chunk)
    try:
        value = json.loads(content)
    except ValueError:
        raise PreflightError(provider + "_INVALID_RESPONSE") from None
    if not isinstance(value, dict):
        raise PreflightError(provider + "_INVALID_RESPONSE")
    return value


async def _check_notion(
    settings: newsletter_settings.Settings,
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    if settings.notion_v2:
        try:
            async with asyncio.timeout(2 * HTTP_TIMEOUT):
                await notion_api.NotionWorkspace(
                    settings.notion_token,
                    settings.notion_materials_data_source_id,
                    settings.notion_editions_data_source_id,
                    transport=transport,
                ).validate()
        except adapters.AdapterError as exc:
            codes = {
                "NOTION_UNAVAILABLE": "NOTION_TEMPORARILY_UNAVAILABLE",
                "NOTION_RATE_LIMITED": "NOTION_TEMPORARILY_UNAVAILABLE",
                "NOTION_AUTH_REJECTED": "NOTION_AUTH_FAILED",
                "NOTION_REJECTED": "NOTION_UNAVAILABLE",
                "NOTION_INVALID_RESPONSE": "NOTION_INVALID_RESPONSE",
                "NOTION_SCHEMA_MISSING": "NOTION_SCHEMA_MISSING",
                "NOTION_SCHEMA_MISMATCH": "NOTION_SCHEMA_INVALID",
            }
            raise PreflightError(
                codes.get(exc.code, "NOTION_CHECK_FAILED")
            ) from None
        return
    adapters.Notion(settings.notion_token, settings.notion_data_source_id)
    identifier = str(uuid.UUID(settings.notion_data_source_id))
    value = await _get_json(
        "https://api.notion.com/v1/data_sources/" + identifier,
        headers={
            "Authorization": "Bearer " + settings.notion_token,
            "Notion-Version": "2026-03-11",
        },
        transport=transport,
        provider="NOTION",
    )
    properties = value.get("properties")
    if (
        value.get("object") != "data_source"
        or value.get("id") != identifier
        or value.get("in_trash", False) is not False
        or value.get("archived", False) is not False
        or not isinstance(properties, dict)
    ):
        raise PreflightError("NOTION_SCHEMA_INVALID")
    titles = [
        p
        for p in properties.values()
        if isinstance(p, dict) and p.get("type") == "title"
    ]
    if len(titles) != 1 or titles[0].get("id") != "title":
        raise PreflightError("NOTION_SCHEMA_INVALID")


async def _check_todofy(
    settings: newsletter_settings.Settings,
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    origin = todofy.validate_todofy_configuration(
        settings.todofy_base_url,
        settings.todofy_user,
        settings.todofy_password,
    )
    # /health is explicitly unauthenticated and performs no generation. Never
    # probe /summary or /recommendation, both of which may trigger paid work.
    value = await _get_json(
        origin + "/health", headers=None, transport=transport, provider="TODOFY"
    )
    if value.get("service") != "todofy" or value.get("status") != "healthy":
        raise PreflightError("TODOFY_UNHEALTHY")


async def _check_notion_availability(
    settings: newsletter_settings.Settings,
    transport: httpx.AsyncBaseTransport | None,
    checks: list[str],
    limitations: list[str],
) -> None:
    try:
        await _check_notion(settings, transport)
    except PreflightError as exc:
        if exc.code != "NOTION_TEMPORARILY_UNAVAILABLE":
            raise
        checks.append("notion_temporarily_unavailable")
    except (httpx.RequestError, TimeoutError):
        checks.append("notion_temporarily_unavailable")
    else:
        checks.append(
            "notion_dual_data_sources_and_managed_schema"
            if settings.notion_v2
            else "notion_data_source_read_and_title_schema"
        )
        limitations.append(
            "Notion read access does not prove Insert content or Update "
            "content "
            "permission; no page or column was created or changed."
        )
    if "notion_temporarily_unavailable" in checks:
        if settings.notion_v2:
            logger.warning(
                "Notion startup check degraded; local evidence remains "
                "authoritative. "
                "Dual-database synchronization may be delayed."
            )
            limitations.append(
                "Notion is temporarily unavailable; local SQLite remains "
                "authoritative. "
                "Dual-database synchronization may be delayed without "
                "blocking email. "
                "No page was created or retried by startup checks."
            )
        else:
            logger.warning(
                "Notion startup check degraded; local evidence remains "
                "authoritative. "
                "Legacy projection gates still apply."
            )
            limitations.append(
                "Notion is temporarily unavailable; local SQLite remains "
                "authoritative. "
                "Publication policies that require confirmed projection "
                "still apply. "
                "No page was created or retried by startup checks."
            )


async def _check_todofy_availability(
    settings: newsletter_settings.Settings,
    transport: httpx.AsyncBaseTransport | None,
    checks: list[str],
    limitations: list[str],
) -> None:
    try:
        await _check_todofy(settings, transport)
    except PreflightError as exc:
        if exc.code != "TODOFY_TEMPORARILY_UNAVAILABLE":
            raise
        checks.append("todofy_temporarily_unavailable")
    except (httpx.RequestError, TimeoutError):
        checks.append("todofy_temporarily_unavailable")
    else:
        checks.append("todofy_public_health_and_configuration")
        limitations.append(
            "Todofy public health does not validate Basic Auth or "
            "downstream summary generation."
        )
    if "todofy_temporarily_unavailable" in checks:
        logger.warning(
            "Todofy startup check degraded; the personal digest may be "
            "unavailable."
        )
        limitations.append(
            "Todofy is temporarily unavailable; the personal digest may be "
            "omitted "
            "without stopping independently prepared news. No summary was "
            "generated."
        )


async def preflight(
    settings: newsletter_settings.Settings,
    *,
    store: newsletter_store.Store | None = None,
    http_transport: httpx.AsyncBaseTransport | None = None,
    sdk: types.ModuleType | None = None,
) -> PreflightReport:
    """Raise on mandatory failures; explicit dependency injection is for tests.

    No environment switch can bypass these gates. Injected create_app adapters
    must not implicitly replace these independent startup checks.
    """
    checks: list[str] = []
    limitations: list[str] = []
    stage = "CONFIGURATION"
    try:
        settings.validate()
        stage = "MODEL_SCHEMA"
        schema_compat.check_production_output_schemas()
        checks.append("model_output_schema_subset")
        stage = "STORAGE"
        _check_storage(settings, store)
        checks.append("sqlite_wal_write_and_integrity")
        stage = "RESOURCES"
        _check_resources()
        checks.append("proto_policy_template_cjk_png")
        if settings.editor_backend == "codex":
            stage = "CODEX"
            await _check_codex(settings, sdk)
            checks.append("codex_runtime_host_auth_skills_model_catalog")
            limitations.append(
                "Codex catalog/auth checks do not execute a model or "
                "verify web-search tools."
            )
        if settings.notion_backend == "notion":
            stage = "NOTION"
            await _check_notion_availability(
                settings, http_transport, checks, limitations
            )
        if settings.todofy_backend == "todofy":
            stage = "TODOFY"
            await _check_todofy_availability(
                settings, http_transport, checks, limitations
            )
        if settings.mail_backend == "resend":
            stage = "MAIL"
            adapters.Resend(
                settings.resend_api_key,
                settings.from_email,
                settings.recipient_email,
            )
            checks.append("resend_configuration_only")
            limitations.append(
                "Resend sending-only keys lack a universal read probe; key "
                "validity, domain and delivery remain unverified. No email "
                "was sent."
            )
    except PreflightError:
        raise
    # Startup is a provider boundary; report only safe stage/type metadata.
    except Exception as error:  # noqa: BLE001
        diagnostics.record_failure(logger, phase=stage.lower(), error=error)
        raise PreflightError(stage + "_CHECK_FAILED") from None
    return PreflightReport(tuple(checks), tuple(limitations))
