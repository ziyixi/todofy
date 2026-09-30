"""Start and stop one runtime-test server before the suite: `uv run python -m tests.runtime.warm_up`.

It goes through the harness itself (the same `pywrangler sync`, launcher and Pyodide disk cache the
tests use), so the ~14 MB Pyodide bundle is downloaded here, with up to three tries, instead of inside
the first test module. It runs no test and asserts nothing about Todofy; CI runs it before each
runtime shard. Optional locally: the harness downloads the bundle on its first start either way.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from tests.runtime.harness import CSRF_SIGNING_KEY, _pyodide_cached, start_gateway

ATTEMPTS = 3


def main() -> int:
    for attempt in range(1, ATTEMPTS + 1):
        with tempfile.TemporaryDirectory(prefix="todofy-warm-up-") as scratch:
            # A subdirectory: the harness keeps its migrated D1 template next to the persist directory.
            state = Path(scratch) / "server"
            state.mkdir()
            server = start_gateway(state, {"CSRF_SIGNING_KEY": CSRF_SIGNING_KEY})
            try:
                next(server)
            # The harness reports a failed start with pytest.fail; a failed `pywrangler sync` (it downloads
            # the pinned workers SDK on a fresh checkout) raises CalledProcessError.
            except (pytest.fail.Exception, subprocess.CalledProcessError) as failure:
                output = getattr(failure, "stderr", None) or ""
                print(f"warm-up attempt {attempt}/{ATTEMPTS} failed: {failure}\n{output}", file=sys.stderr)
                continue
            finally:
                server.close()
        if _pyodide_cached():
            print(f"test server started and stopped (attempt {attempt}); the Pyodide bundle is cached")
            return 0
        print(f"warm-up attempt {attempt}/{ATTEMPTS}: no Pyodide bundle in the disk cache", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
