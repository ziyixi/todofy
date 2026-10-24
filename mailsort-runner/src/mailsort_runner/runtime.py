"""Pinned Codex SDK with tools disabled and a dedicated auth directory."""

import importlib
import json
import os
import sys
from importlib import metadata
from pathlib import Path

from mailsort_runner._runtime import ENV_KEYS
from mailsort_runner.settings import SDK_VERSION, RunnerError

SYSTEM_SKILLS = (
    "imagegen",
    "openai-docs",
    "plugin-creator",
    "review-agent",
    "skill-creator",
    "skill-installer",
)
CONFIG = (
    'forced_login_method="chatgpt"',
    'cli_auth_credentials_store="file"',
    'model_provider="openai"',
    'web_search="disabled"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'history.persistence="none"',
    "project_doc_max_bytes=0",
    "check_for_update_on_startup=false",
    *(
        f"features.{name}=false"
        for name in (
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
            "image_generation",
            "view_image",
            "skill_search",
            "tool_suggest",
            "workspace_dependencies",
            "shell_snapshot",
            "goals",
            "auth_elicitation",
            "tool_call_mcp_elicitation",
            "code_mode_host",
        )
    ),
)


def load_sdk():
    for package in ("openai-codex", "openai-codex-cli-bin"):
        try:
            if metadata.version(package) != SDK_VERSION:
                raise RunnerError("configuration")
        except metadata.PackageNotFoundError:
            raise RunnerError("configuration") from None
    return importlib.import_module("openai_codex")


def launch_args(overrides: tuple[str, ...], *command: str) -> tuple[str, ...]:
    helper = Path(__file__).with_name("_runtime.py")
    args = [sys.executable, "-I", str(helper)]
    for value in overrides:
        args.extend(["--config", value])
    return (*args, *command)


def config(sdk, home: Path, workspace: Path):
    # The SDK overlays env on os.environ. Blank secrets before its Python helper
    # starts; the helper then removes all non-allowlisted keys before execve.
    environment = {key: value if key in ENV_KEYS else "" for key, value in os.environ.items()}
    environment.update(CODEX_HOME=str(home), HOME=str(workspace))
    skills = [
        "{path="
        + json.dumps(str(home / "skills" / ".system" / name / "SKILL.md"))
        + ",enabled=false}"
        for name in SYSTEM_SKILLS
    ]
    overrides = (*CONFIG, "skills.config=[" + ",".join(skills) + "]")
    return sdk.CodexConfig(
        cwd=str(workspace),
        env=environment,
        config_overrides=overrides,
        launch_args_override=launch_args(overrides, "app-server", "--listen", "stdio://"),
        client_name="mailsort_runner",
    )
