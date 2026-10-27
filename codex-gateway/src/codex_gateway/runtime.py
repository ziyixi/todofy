"""Pinned official CLI configuration and safe execution boundaries."""

import asyncio
import json
import os
import pathlib
import sys
from typing import Any

from openai_codex.errors import (
    InvalidParamsError,
    InvalidRequestError,
    JsonRpcError,
    RetryLimitExceededError,
    ServerBusyError,
)
from openai_codex.generated.v2_all import TurnError
from ziyixi_proto.modelrouter.inference.v1.inference_pb import ModelError
from ziyixi_proto.rpc_status import RpcError

MODEL = "gpt-6.1-sol"
SYSTEM_SKILLS = (
    "imagegen",
    "openai-docs",
    "review-agent",
    "skill-creator",
    "skill-installer",
)
CONFIG_OVERRIDES = (
    'forced_login_method="chatgpt"',
    'cli_auth_credentials_store="file"',
    'model_provider="openai"',
    'web_search="disabled"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'history.persistence="none"',
    "mcp_servers={}",
    "project_doc_max_bytes=0",
    "check_for_update_on_startup=false",
    *(
        f"features.{name}=false"
        for name in (
            # The pinned runtime's shell_tool switch disables command tools.
            "shell_tool",
            "hooks",
            "apps",
            "multi_agent",
            "memories",
            "skill_mcp_dependency_install",
            "browser_use",
            "browser_use_external",
            "browser_use_full_cdp_access",
            "computer_use",
            "in_app_browser",
            "plugins",
            "remote_plugin",
            "code_mode_host",
            "image_generation",
            "view_image",
            "skill_search",
            "tool_suggest",
            "workspace_dependencies",
            "shell_snapshot",
            "goals",
            "sleep_tool",
            "auth_elicitation",
            "tool_call_mcp_elicitation",
        )
    ),
)


def runtime_overrides(
    home: pathlib.Path, *, web_research: bool = False
) -> tuple[str, ...]:
    disabled = [
        {"path": str(home / "skills" / ".system" / name / "SKILL.md"), "enabled": False}
        for name in SYSTEM_SKILLS
    ]
    skills = ",".join(
        "{path=" + json.dumps(item["path"]) + ",enabled=false}" for item in disabled
    )
    overrides = tuple(
        value
        for value in CONFIG_OVERRIDES
        if not web_research
        or value not in {'web_search="disabled"', "features.code_mode_host=false"}
    )
    web = ('web_search="live"', "features.code_mode_host=true") if web_research else ()
    return (*overrides, *web, "skills.config=[" + skills + "]")


def runtime_config(
    sdk: Any,
    home: pathlib.Path,
    workspace: pathlib.Path,
    *,
    web_research: bool = False,
) -> Any:
    overrides = runtime_overrides(home, web_research=web_research)
    args = [
        sys.executable,
        "-I",
        str(pathlib.Path(__file__).with_name("_launch.py")),
        "--gateway-parent-pid",
        str(os.getpid()),
    ]
    for override in overrides:
        args.extend(["--config", override])
    args.extend(["app-server", "--listen", "stdio://"])
    return sdk.CodexConfig(
        cwd=str(workspace),
        env={"CODEX_HOME": str(home)},
        launch_args_override=tuple(args),
        config_overrides=overrides,
        client_name="codex_inference_gateway",
    )


def execution_error(error: BaseException) -> ModelError:
    """Normalize only known SDK categories; never expose diagnostic text."""
    data = error.data if isinstance(error, JsonRpcError) else None
    if error.args and isinstance(error.args[0], TurnError):
        data = error.args[0].model_dump(mode="json", by_alias=True)
    info = data
    if isinstance(data, dict):
        info = (
            data.get("codexErrorInfo")
            or data.get("codex_error_info")
            or data.get("errorInfo")
        )
    category = info.replace("_", "").lower() if isinstance(info, str) else ""
    http_status = None
    if isinstance(info, dict):
        for variant in (
            "httpConnectionFailed",
            "responseStreamConnectionFailed",
            "responseStreamDisconnected",
            "responseTooManyFailedAttempts",
        ):
            detail = info.get(variant)
            if isinstance(detail, dict) and type(detail.get("httpStatusCode")) is int:
                http_status = detail["httpStatusCode"]
                break
    if (
        category == "unauthorized"
        or http_status in (401, 403)
        or isinstance(error, RpcError)
        and error.code in ("UNAUTHENTICATED", "PERMISSION_DENIED")
    ):
        return ModelError(
            code=16, reason="MODEL_AUTH", message="Model authentication unavailable"
        )
    if category in ("usagelimitexceeded", "sessionbudgetexceeded"):
        return ModelError(
            code=8, reason="MODEL_QUOTA", message="Model usage limit reached"
        )
    if category == "ratelimitexceeded" or http_status == 429:
        return ModelError(
            code=8, reason="MODEL_RATE_LIMIT", message="Model request rate is limited"
        )
    if (
        category == "badrequest"
        or http_status in (400, 422)
        or isinstance(error, (InvalidRequestError, InvalidParamsError))
    ):
        return ModelError(
            code=3,
            reason="MODEL_INVALID_REQUEST",
            message="Model rejected the invocation",
        )
    if category == "serveroverloaded" or (
        isinstance(error, ServerBusyError)
        and not isinstance(error, RetryLimitExceededError)
    ):
        return ModelError(
            code=14, reason="MODEL_BUSY", message="Model is temporarily busy"
        )
    return ModelError(
        code=14, reason="MODEL_UNAVAILABLE", message="Model execution unavailable"
    )


async def _assert_no_skills(client: Any, workspace: pathlib.Path) -> None:
    from openai_codex.generated.v2_all import SkillsListResponse

    result = await client._client.request(
        "skills/list",
        {"cwds": [str(workspace)], "forceReload": True},
        response_model=SkillsListResponse,
    )
    if len(result.data) != 1 or result.data[0].cwd != str(workspace):
        raise RuntimeError("codex_unavailable")
    if result.data[0].errors or any(skill.enabled for skill in result.data[0].skills):
        raise RuntimeError("codex_unavailable")


async def _interrupt(turn: Any) -> None:
    try:
        await asyncio.wait_for(turn.interrupt(), timeout=2)
    except Exception:
        pass
