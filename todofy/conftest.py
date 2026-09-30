"""Project-wide pytest settings that must hold however pytest is started.

It sits at the rootdir, so pytest loads it for every invocation in todofy/, whatever paths are
given. The pytest-xdist controller never collects tests (its workers do), so a check in a conftest
below tests/ is not loaded on the controller when tests/runtime is reached by directory recursion
(``pytest tests -n 2``) and cannot see the distribution mode.
"""

import pytest

# The runtime modules share one Worker per module and some of their tests rely on the ones before them,
# so a file must run whole and in order in one process. Only --dist loadfile (the default in
# pyproject.toml) guarantees that; load, worksteal, loadgroup and each split a file between processes,
# and loadscope splits a file that has test classes.
ALLOWED_DIST = ("no", "loadfile")


def pytest_configure(config: pytest.Config) -> None:
    if hasattr(config, "workerinput"):
        return  # an xdist worker: the controller checked the mode before it started any worker
    dist = config.getoption("dist", "no")
    if config.getoption("numprocesses", None) and dist not in ALLOWED_DIST:
        raise pytest.UsageError(f"todofy's tests run whole files per process: use --dist loadfile, not {dist}")
