import socket
import time
from collections.abc import Iterator

import httpx
import pytest

from tests.fakes.server import FakeServer, Reply


@pytest.fixture
def fake() -> Iterator[FakeServer]:
    server = FakeServer()
    yield server
    server.close()


def test_queued_replies_are_fifo_then_default(fake: FakeServer) -> None:
    fake.queue("POST", "/x", Reply(429, "slow down", {"retry-after": "7"}))
    fake.queue("POST", "/x", Reply(200, {"ok": True}))
    fake.default("POST", "/x", Reply(204))

    first = httpx.post(f"{fake.url}/x")
    second = httpx.post(f"{fake.url}/x")
    third = httpx.post(f"{fake.url}/x")

    assert (first.status_code, first.headers["retry-after"], first.text) == (429, "7", "slow down")
    assert (second.status_code, second.json()) == (200, {"ok": True})
    assert third.status_code == 204
    assert httpx.get(f"{fake.url}/unknown").status_code == 404


def test_records_method_path_query_headers_and_body(fake: FakeServer) -> None:
    fake.default("POST", "/tasks", Reply(200, {}))
    httpx.post(f"{fake.url}/tasks?cursor=abc", json={"a": 1}, headers={"X-Request-Id": "r1"})

    [request] = fake.received("POST", "/tasks")
    assert request.query == {"cursor": ["abc"]}
    assert request.headers["x-request-id"] == "r1"
    assert request.json() == {"a": 1}


def test_delay_postpones_the_reply(fake: FakeServer) -> None:
    fake.queue("GET", "/slow", Reply(200, delay_ms=300))
    started = time.monotonic()
    assert httpx.get(f"{fake.url}/slow").status_code == 200
    assert time.monotonic() - started >= 0.3


def test_hang_lasts_until_the_client_disconnects(fake: FakeServer) -> None:
    fake.queue("GET", "/hang", Reply(hang=True))
    port = int(fake.url.rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port)) as client:
        client.sendall(b"GET /hang HTTP/1.1\r\nHost: fake\r\n\r\n")
        fake.wait_for(lambda: fake.received("GET", "/hang"))
        client.settimeout(0.3)
        with pytest.raises(TimeoutError):
            client.recv(1)
    assert fake.wait_for(lambda: fake.disconnects) == ["/hang"]
