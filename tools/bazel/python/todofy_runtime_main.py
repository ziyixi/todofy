"""Stage declared Todofy inputs and run its existing real-workerd scenarios."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

workspace = Path(os.environ["TEST_SRCDIR"]) / os.environ["TEST_WORKSPACE"]
root = Path(os.environ["TEST_TMPDIR"]).resolve() / "workspace"
root.mkdir()
# rules_js documents this value for invocations from a test runfiles tree.
os.environ["BAZEL_BINDIR"] = "."
for name in ("BAZEL_WRANGLER", "BAZEL_WORKERD", "BAZEL_PYODIDE"):
    os.environ[name] = str(Path(os.environ[name]).absolute())
source = workspace / "todofy"
app = root / "todofy"
# Workerd needs writable local databases and generated per-server configs. Only
# declared app inputs are copied; Node packages and tools stay in runfiles.
shutil.copytree(source, app, ignore=shutil.ignore_patterns("node_modules", "*.venv"))
shutil.copytree(app / "web/dist", app / "uiassets/dist")
for relative in (
    "todofy/node_modules",
    "todofy/gateway/node_modules",
    "proto",
    "packages",
    "contracts",
):
    if (workspace / relative).exists():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(workspace / relative, target_is_directory=True)
cache = app / ".wrangler/pyodide-cache"
cache.mkdir(parents=True)
bundle = Path(os.environ["BAZEL_PYODIDE"])
shutil.copyfile(bundle, cache / bundle.name)
sys.path[:] = [
    str(root / Path(path).relative_to(workspace))
    if Path(path).is_relative_to(workspace / "todofy")
    else path
    for path in sys.path
]
os.environ["PYTHONPATH"] = os.pathsep.join(sys.path)
os.chdir(root)
# Miniflare uses extra control descriptors; invoke the native binary directly.
os.environ["BAZEL_WORKERD"] = subprocess.check_output(
    [os.environ["BAZEL_WORKERD"]], text=True
).strip()


class RuntimeResults:
    def __init__(self):
        self.skipped = []

    def pytest_runtest_logreport(self, report):
        if report.skipped:
            self.skipped.append(report.nodeid)

    def pytest_collectreport(self, report):
        if report.skipped:
            self.skipped.append(report.nodeid)


results = RuntimeResults()
arguments = sys.argv[1:] + [
    "--basetemp=" + str(Path(os.environ["TEST_TMPDIR"]) / "pytest")
]
if output := os.environ.get("XML_OUTPUT_FILE"):
    arguments += ["--junitxml=" + output, "-o", "junit_family=xunit2"]
status = pytest.main(arguments, plugins=[results])
if status and (outputs := os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR")):
    for log in (Path(os.environ["TEST_TMPDIR"]) / "pytest").rglob("dev.log"):
        destination = Path(outputs) / log.relative_to(Path(os.environ["TEST_TMPDIR"]))
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(log, destination)
if results.skipped:
    print("Unexpected runtime skips: " + ", ".join(results.skipped), file=sys.stderr)
    status = 1
raise SystemExit(status)
