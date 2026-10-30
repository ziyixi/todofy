"""Run the root-lock Ruff executable in the application's declared source tree."""

import os
import subprocess
import sys
from pathlib import Path

executable = Path(sys.argv[1]).absolute()
project = Path(sys.argv[2]).absolute()
if workspace := os.environ.get("BUILD_WORKSPACE_DIRECTORY"):
    project = Path(workspace) / sys.argv[2]
subprocess.run(
    [str(executable), *sys.argv[3:], "--no-cache"],
    cwd=project.parent,
    check=True,
)
