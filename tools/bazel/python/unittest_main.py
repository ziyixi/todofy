"""Run the declared unittest module, including files without a main guard."""

import importlib
import os
import shutil
import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    if binaries := os.environ.get("BAZEL_TEST_BIN"):
        os.environ["PATH"] = (
            str(Path(binaries).absolute())
            + os.pathsep
            + os.environ.get("PATH", os.defpath)
        )
    if os.environ.get("BAZEL_COPY_WORKSPACE") == "1":
        workspace = Path(os.environ["TEST_SRCDIR"]) / os.environ["TEST_WORKSPACE"]
        copied = Path(os.environ["TEST_TMPDIR"]).resolve() / "workspace"
        # Keep strict configuration loaders' regular-file requirement intact.
        shutil.copytree(workspace, copied, ignore=shutil.ignore_patterns("*.venv"))
        sys.path[:] = [
            str(copied / Path(path).relative_to(workspace))
            if Path(path).is_relative_to(workspace)
            else path
            for path in sys.path
        ]
        os.environ["PYTHONPATH"] = os.pathsep.join(sys.path)
        os.chdir(copied)
    module = importlib.import_module(sys.argv[1])
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    if not suite.countTestCases():
        raise SystemExit("The declared unittest module contains no tests")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
