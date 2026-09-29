"""Size checks happen on headers alone, before the Worker reads any body.

These requests can leave wrangler's local proxy unable to serve the next POST,
so each runs against its own short-lived dev server.
"""

from tests.runtime.harness import AUTH, HOOKS_HOST, Worker

MIB = 1 << 20


def test_declared_length_over_the_limit_is_rejected_before_reading(throwaway_worker: Worker) -> None:
    headers = AUTH | {"content-length": str(MIB + 1)}
    assert throwaway_worker.headers_only_status(HOOKS_HOST, "POST", "/hooks/mail", headers) == 413


def test_missing_length_is_rejected(throwaway_worker: Worker) -> None:
    headers = AUTH | {"transfer-encoding": "chunked"}
    assert throwaway_worker.headers_only_status(HOOKS_HOST, "POST", "/hooks/mail", headers) == 411
