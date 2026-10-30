"""Run a declared pytest test file with the target's locked dependencies."""

import os
import shutil
import sys
import venv
from pathlib import Path

import pytest

if __name__ == "__main__":
    if binaries := os.environ.get("BAZEL_TEST_BIN"):
        os.environ["PATH"] = (
            str(Path(binaries).absolute())
            + os.pathsep
            + os.environ.get("PATH", os.defpath)
        )
    if font := os.environ.get("NEWSLETTER_CHART_FONT"):
        os.environ["NEWSLETTER_CHART_FONT"] = str(Path(font).absolute())
    if os.environ.get("BAZEL_COPY_WORKSPACE") == "1":
        workspace = Path(os.environ["TEST_SRCDIR"]) / os.environ["TEST_WORKSPACE"]
        copied = Path(os.environ["TEST_TMPDIR"]).resolve() / "workspace"
        # Business configuration loaders reject symlinks. Copy only declared
        # workspace inputs; wheels and the Python toolchain stay in runfiles.
        shutil.copytree(
            workspace,
            copied,
            ignore=shutil.ignore_patterns("*.venv"),
        )
        sys.path[:] = [
            str(copied / Path(path).relative_to(workspace))
            if Path(path).is_relative_to(workspace)
            else path
            for path in sys.path
        ]
        os.environ["PYTHONPATH"] = os.pathsep.join(sys.path)
        os.chdir(copied)
    if os.environ.get("BAZEL_CHILD_PYTHON") == "1":
        # A few tests clear the child environment to check import boundaries.
        # Give those children the same declared imports through a fresh venv.
        child = Path(os.environ["TEST_TMPDIR"]).resolve() / "child-python"
        builder = venv.EnvBuilder(with_pip=False)
        builder.create(child)
        context = builder.ensure_directories(child)
        (Path(context.lib_path) / "bazel-imports.pth").write_text(
            "\n".join(sys.path) + "\n"
        )
        sys.executable = context.env_exec_cmd
    raise SystemExit(pytest.main(sys.argv[1:]))
