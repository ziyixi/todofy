"""The project's pytest setup: pytest-xdist may only hand out whole files (the rootdir conftest.py).

Each case starts pytest in a subprocess from the rootdir. A refused mode stops in pytest_configure,
before any worker or test server starts.
"""

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
REFUSED = "todofy's tests run whole files per process"


def run_pytest(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


@pytest.mark.parametrize("dist", ["load", "worksteal", "loadgroup", "each", "loadscope", "no"])
@pytest.mark.parametrize(
    "paths",
    [
        ["tests/runtime/test_configs.py"],
        # tests/runtime reached by directory recursion: its own conftest.py is never loaded on the controller.
        ["tests", "-k", "test_configs"],
        [],
    ],
    ids=["runtime-file", "recursion", "testpaths"],
)
def test_per_test_distribution_is_refused_however_the_runtime_tests_are_reached(dist: str, paths: list[str]) -> None:
    # --dist no with -n is xdist's own alias for --dist load.
    result = run_pytest(*paths, "-n", "2", "--dist", dist, "--collect-only", "-q")
    assert result.returncode == pytest.ExitCode.USAGE_ERROR, result.stdout + result.stderr
    assert REFUSED in result.stderr


def test_whole_files_per_process_run() -> None:
    result = run_pytest("tests/unit/test_backoff.py", "-n", "2", "-q")
    assert result.returncode == pytest.ExitCode.OK, result.stdout + result.stderr
    assert REFUSED not in result.stderr
