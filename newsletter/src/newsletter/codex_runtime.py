"""Pinned Codex SDK loading, isolated launch policy, and disabled-skill checks.

This module does not start a process or inspect credentials during import.
The _codex_runtime.py helper is the final exact-environment exec boundary.
"""

from __future__ import annotations

import importlib
import importlib.metadata as metadata
import json
import os
import pathlib
import sys
import types
from typing import TYPE_CHECKING

import newsletter._codex_runtime as _codex_runtime
import newsletter.errors as errors

if TYPE_CHECKING:
    import openai_codex

SDK_VERSION = "0.156.1"


SYSTEM_SKILLS = (
    "imagegen",
    "openai-docs",
    "plugin-creator",
    "review-agent",
    "skill-creator",
    "skill-installer",
)


def load_sdk() -> types.ModuleType:
    """Load only the pinned optional SDK; normalize missing dependencies."""
    try:
        if metadata.version("openai-codex") != SDK_VERSION:
            raise errors.EditorError("configuration")
        return importlib.import_module("openai_codex")
    except (ImportError, metadata.PackageNotFoundError):
        raise errors.EditorError("configuration") from None


def runtime_env(codex_home: pathlib.Path) -> dict[str, str]:
    """Blank inherited secrets before the isolated helper removes their keys."""
    # Blank secrets before launching the isolated Python helper; its final exec
    # actually removes non-allowlisted keys. Empty is NOT equivalent to unset.
    env = {
        key: value if key in _codex_runtime.RUNTIME_ENV_KEYS else ""
        for key, value in os.environ.items()
    }
    env["CODEX_HOME"] = str(codex_home)
    return env


def launch_args(overrides: tuple[str, ...]) -> tuple[str, ...]:
    """Build the exact-environment helper command without starting a process."""
    helper = pathlib.Path(__file__).with_name("_codex_runtime.py")
    if helper.is_symlink() or not helper.is_file():
        raise errors.EditorError("configuration")
    args = [sys.executable, "-I", str(helper)]
    for item in overrides:
        args.extend(["--config", item])
    return (*args, "app-server", "--listen", "stdio://")


def skill_paths(codex_home: pathlib.Path) -> set[str]:
    """Return every system skill path installed by the pinned runtime."""
    return {
        str(codex_home / "skills" / ".system" / name / "SKILL.md")
        for name in SYSTEM_SKILLS
    }


def runtime_overrides(codex_home: pathlib.Path) -> tuple[str, ...]:
    """Disable local tools and skills in the dedicated research runtime."""
    # Pinned 0.156.1 requires SKILL.md paths (not skill directories). This also
    # covers a fresh home, before the runtime auto-installs its system skills.
    entries = [
        "{path=" + json.dumps(path, ensure_ascii=False) + ",enabled=false}"
        for path in sorted(skill_paths(codex_home))
    ]
    return (*CONFIG_OVERRIDES, "skills.config=[" + ",".join(entries) + "]")


async def assert_no_skills(
    client: openai_codex.AsyncCodex,
    workspace: pathlib.Path,
    codex_home: pathlib.Path,
) -> None:
    """Verify effective skill state before any model request is allowed."""
    # Keep the optional SDK out of offline command imports.
    import openai_codex.generated.v2_all as v2_all  # noqa: PLC0415

    # High-level 0.156.1 has no skills-list convenience method; use its typed
    # transport. This read cannot invoke a skill or change its configuration.
    result = await client._client.request(  # noqa: SLF001
        "skills/list",
        {"cwds": [str(workspace)], "forceReload": True},
        response_model=v2_all.SkillsListResponse,
    )
    if len(result.data) != 1 or result.data[0].cwd != str(workspace):
        raise errors.EditorError("configuration")
    entry = result.data[0]
    if entry.errors or any(
        skill.enabled or skill.scope.value != "system" for skill in entry.skills
    ):
        raise errors.EditorError("configuration")
    if {skill.path.root for skill in entry.skills} != skill_paths(codex_home):
        raise errors.EditorError("configuration")


CONFIG_OVERRIDES = (
    'forced_login_method="chatgpt"',
    'cli_auth_credentials_store="file"',
    'model_provider="openai"',
    'web_search="live"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'history.persistence="none"',
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.hooks=false",
    "features.apps=false",
    "features.multi_agent=false",
    "features.memories=false",
    "features.skill_mcp_dependency_install=false",
    "project_doc_max_bytes=0",
    # Confirmed with the pinned runtime's offline `features list`, not guessed
    # from shell sandboxing. Browser/desktop/plugin tools are separate surfaces.
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.browser_use_full_cdp_access=false",
    "features.computer_use=false",
    "features.in_app_browser=false",
    "features.plugins=false",
    "features.remote_plugin=false",
    # The pinned runtime routes hosted web tools through this execution host.
    # It is infrastructure, not permission to enable shell/plugins/local tools.
    "features.code_mode_host=true",
    "features.image_generation=false",
    "features.view_image=false",
    "features.skill_search=false",
    "features.tool_suggest=false",
    "features.workspace_dependencies=false",
    "features.shell_snapshot=false",
    "features.goals=false",
    "features.auth_elicitation=false",
    "features.tool_call_mcp_elicitation=false",
    "check_for_update_on_startup=false",
)


def check_codex_home(
    path: pathlib.Path, workspace: pathlib.Path
) -> pathlib.Path:
    """Validate the dedicated login directory without reading credentials."""
    absolute = path.absolute()
    if (
        not absolute.is_dir()
        or absolute == pathlib.Path.home() / ".codex"
        or any(p.is_symlink() for p in (absolute, *absolute.parents))
        or absolute == workspace
        or absolute.is_relative_to(workspace)
    ):
        raise errors.EditorError("configuration")
    # Dedicated login state only: do not inherit arbitrary MCP, provider,
    # plugin,
    # hook or project configuration. No auth file is opened by this application.
    for name in (
        "config.toml",
        "hooks.json",
        "AGENTS.md",
        "AGENTS.override.md",
        "plugins",
    ):
        if (absolute / name).exists() or (absolute / name).is_symlink():
            raise errors.EditorError("configuration")
    for parent in (workspace, *workspace.parents):
        for name in (
            ".codex/config.toml",
            ".codex/hooks.json",
            ".agents/skills",
        ):
            if (parent / name).exists() or (parent / name).is_symlink():
                raise errors.EditorError("configuration")
    for root in (
        pathlib.Path.home() / ".agents" / "skills",
        pathlib.Path("/etc/codex/skills"),
    ):
        if root.exists() or root.is_symlink():
            raise errors.EditorError("configuration")
    _check_skill_cache(absolute)
    return absolute


def _check_skill_cache(absolute: pathlib.Path) -> None:
    # The runtime itself populates skills/.system. Keep that cache, disable all
    # pinned entries, then verify their effective state before any model turn.
    skills = absolute / "skills"
    if skills.is_symlink() or (skills.exists() and not skills.is_dir()):
        raise errors.EditorError("configuration")
    if skills.exists():
        if any(child.name != ".system" for child in skills.iterdir()):
            raise errors.EditorError("configuration")
        system = skills / ".system"
        if system.is_symlink() or (system.exists() and not system.is_dir()):
            raise errors.EditorError("configuration")
        if system.exists():
            allowed = {*SYSTEM_SKILLS, ".codex-system-skills.marker"}
            if any(child.name not in allowed for child in system.iterdir()):
                raise errors.EditorError("configuration")
            for index, child in enumerate(system.rglob("*")):
                if index > 2000 or child.is_symlink():
                    raise errors.EditorError("configuration")
