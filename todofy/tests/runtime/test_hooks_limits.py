"""The 1 MiB cap: a declared length is refused on headers alone, an undeclared one while reading.

These requests can leave wrangler's local proxy unable to serve the next POST,
so each runs against its own short-lived dev server.
"""

import pytest

from tests.runtime.harness import AUTH, HOOKS_HOST, Worker, error_code, mail_event

MIB = 1 << 20


@pytest.mark.reaches("payload_too_large")
def test_declared_length_over_the_limit_is_rejected_before_reading(throwaway_worker: Worker) -> None:
    headers = AUTH | {"content-length": str(MIB + 1)}
    assert throwaway_worker.headers_only_status(HOOKS_HOST, "POST", "/hooks/mail", headers) == 413


def test_undeclared_length_over_the_limit_is_cut_off(throwaway_worker: Worker) -> None:
    event_id, body = mail_event(size=MIB + 4096)
    chunks = iter([body[i : i + 65536] for i in range(0, len(body), 65536)])
    response = throwaway_worker.hooks.post("/hooks/mail", content=chunks, headers=AUTH | {"idempotency-key": event_id})
    assert (response.status_code, error_code(response)) == (413, "payload_too_large")
    assert throwaway_worker.event(event_id) is None
