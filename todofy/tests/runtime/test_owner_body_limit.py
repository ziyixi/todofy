"""The object stops reading an owner write body at 16 KiB, even without a Content-Length.

The object also runs ingest and the alarm loop, so a chunked owner body must not be buffered
whole. Whether an unfinished upload reaches the object at all is up to wrangler's local proxy
(it passes chunks on only in large pieces), so the early stop is proven on ``read_capped`` itself
with a JS stream in real workerd; the owner route is checked with a complete chunked body.
"""

import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from tests.runtime.clients_probe import start_probe
from tests.runtime.harness import Worker, error_code

CAP = 16 << 10  # api.MAX_BODY_BYTES
CHUNK = 4096
# 3.2 MiB: a reader that drained the stream would report every piece.
CHUNKS = 800


@pytest.fixture(scope="module")
def probe(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    yield from start_probe(tmp_path_factory.mktemp("body-reader"), {})


def read_from_stub(probe: Worker, chunks: int) -> dict[str, Any]:
    response = probe.hooks.post("/read-capped", json={"chunk": CHUNK, "chunks": chunks, "limit": CAP})
    assert response.status_code == 200, response.text
    result = response.json()
    del result["elapsed_ms"]
    return result


def test_the_reader_stops_at_the_first_piece_past_the_cap(probe: Worker) -> None:
    # The fifth 4 KiB piece crosses 16 KiB: the reader cancels the stream and reads nothing after it.
    assert read_from_stub(probe, CHUNKS) == {"size": None, "pulled": CAP // CHUNK + 1, "cancelled": True}


def test_the_reader_returns_a_body_of_exactly_the_cap(probe: Worker) -> None:
    assert read_from_stub(probe, CAP // CHUNK) == {"size": CAP, "pulled": CAP // CHUNK, "cancelled": False}


def chunked_recompute(worker: Worker, size: int) -> tuple[str, httpx.Response]:
    """A valid recompute request padded with JSON whitespace to ``size`` bytes, sent chunked."""
    action_id = str(uuid.uuid4())
    head = b'{"kind":"summary","action_request_id":"%s"' % action_id.encode()
    body = head + b" " * (size - len(head) - 1) + b"}"
    pieces = iter([body[i : i + CHUNK] for i in range(0, size, CHUNK)])
    headers = worker.csrf_headers() | {"content-type": "application/json"}
    response = worker.owner.post("/api/v1/reports/recompute", content=pieces, headers=headers)
    assert "content-length" not in response.request.headers
    return action_id, response


def test_chunked_owner_body_over_the_cap_is_refused(throwaway_worker: Worker) -> None:
    # At the cap the padded request is served, so the refusal below is the cap alone.
    _, served = chunked_recompute(throwaway_worker, CAP)
    assert served.status_code == 200, served.text
    # The object answers before reading the rest, so this runs on its own dev server, last.
    action_id, refused = chunked_recompute(throwaway_worker, CAP + 1)
    assert (refused.status_code, error_code(refused)) == (400, "invalid_request")
    assert throwaway_worker.d1(f"SELECT 1 FROM owner_actions WHERE action_request_id = '{action_id}'") == []
    throwaway_worker.overview()  # the object still serves
