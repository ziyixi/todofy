"""Stage exactly the declared public source manifest for repository audits."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def stage(manifest: str, *, git_index: bool = False) -> Path:
    if node := os.environ.get("BAZEL_NODE"):
        os.environ["PATH"] = (
            str(Path(node).absolute().parent)
            + os.pathsep
            + os.environ.get("PATH", os.defpath)
        )
    workspace = Path(os.environ["TEST_SRCDIR"]) / os.environ["TEST_WORKSPACE"]
    root = Path(os.environ["TEST_TMPDIR"]).resolve() / "repository"
    root.mkdir()
    for relative in json.loads(Path(manifest).read_text()):
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(
                "The repository fixture must contain workspace-relative files"
            )
        destination = root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(workspace / path, destination)
    sys.path[:] = [
        str(root / Path(path).relative_to(workspace))
        if Path(path).is_relative_to(workspace)
        else path
        for path in sys.path
    ]
    sys.path[:0] = [str(root / ".github/scripts")]
    os.environ["PYTHONPATH"] = os.pathsep.join(sys.path)
    os.chdir(root)
    if git_index:
        # The audits inspect tracked paths and ignore rules, never real Git history.
        env = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        }
        subprocess.run(
            ["git", "-c", "init.defaultBranch=synthetic", "init", "-q"],
            env=env,
            check=True,
        )
        subprocess.run(["git", "add", "--force", "."], env=env, check=True)
    return root
