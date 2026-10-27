"""Pinned official CLI configuration and safe execution boundaries."""

import asyncio
import json
import os
import pathlib
import sys
from typing import Any

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


def failure_code(error: object) -> str:
    """Inspect vendor diagnostics locally; return only a fixed safe code."""
    text = str(error).lower()
    if any(
        word in text
        for word in (
            "unauthorized",
            "unauthenticated",
            "authentication",
            "not logged in",
            "401",
            "403",
        )
    ):
        return "codex_auth"
    if any(
        word in text
        for word in (
            "usage_limit",
            "usagelimit",
            "rate_limit",
            "rate limit",
            "quota",
            "429",
        )
    ):
        return "codex_quota"
    return "codex_unavailable"


def _login_home(home: pathlib.Path) -> None:
    # The image has no host config mounts. The shared mount supplies login only.
    if not home.is_absolute() or not home.is_dir():
        raise RuntimeError("codex_unavailable")
    if any(
        (home / name).exists()
        for name in (
            "config.toml",
            "hooks.json",
            "AGENTS.md",
            "AGENTS.override.md",
            "plugins",
        )
    ):
        raise RuntimeError("codex_unavailable")


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
