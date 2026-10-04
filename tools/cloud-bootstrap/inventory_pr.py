"""Publish only public inventory/generated files from an isolated local clone."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from private_input import BootstrapError


def _run(arguments: list[str], cwd: Path) -> str:
    try:
        result = subprocess.run(arguments, cwd=cwd, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BootstrapError("INVENTORY_PR_COMMAND_FAILED") from None
    if result.returncode or len(result.stdout) > 65536:
        raise BootstrapError("INVENTORY_PR_COMMAND_FAILED")
    return result.stdout.decode().strip()


def create(repository: Path, remote: str) -> str:
    source = _run(["git", "rev-parse", "HEAD"], repository)
    branch = "codex/bootstrap-inventory-" + source[:12]
    with tempfile.TemporaryDirectory(prefix="todofy-inventory-") as directory:
        work = Path(directory) / "checkout"
        _run(["git", "clone", "--quiet", "--no-hardlinks", str(repository), str(work)], Path(directory))
        _run(["git", "checkout", "-b", branch, source], work)
        _run(["git", "remote", "set-url", "origin", "https://github.com/" + remote + ".git"], work)
        shutil.copyfile(repository / "config/resources.toml", work / "config/resources.toml")
        _run([sys.executable, "tools/cloud-config/generate.py"], work)
        _run([sys.executable, "tools/service-catalog/catalog.py"], work)
        changed = _run(["git", "diff", "--name-only"], work).splitlines()
        # A bootstrap inventory cannot carry business source, docs or credentials.
        allowed = {"config/resources.toml", "infra/ids.tf", "dashboard/worker/src/resource-identities.ts"}
        if set(changed) - allowed:
            raise BootstrapError("INVENTORY_PR_SCOPE_INVALID")
        if not changed:
            return ""
        _run(["git", "add", "--", *changed], work)
        _run(["git", "commit", "-m", "Record verified first-release Cloudflare identities"], work)
        _run(["git", "push", "origin", "HEAD:refs/heads/" + branch], work)
        result = _run(["gh", "pr", "create", "--repo", remote, "--base", "main", "--head", branch,
                       "--title", "Record verified Cloudflare bootstrap identities",
                       "--body", "Record namespace IDs from the first verified full release and its exact mail rule. "
                       "Only public inventory and generated files change. Merge after the full CI gate passes."], work)
        # Explicit dispatch also works when a bot credential pushed the branch.
        _run(["gh", "workflow", "run", "ci.yml", "--repo", remote, "--ref", branch, "-f", "app=all"], work)
        return result
