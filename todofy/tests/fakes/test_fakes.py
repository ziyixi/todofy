import email.utils
import socket
import time
from collections.abc import Iterator

import httpx
import pytest

from tests.fakes.model_router_fake import GENERATE_PATH, ModelRouterFake, error_reply
from tests.fakes.server import (
    PASS,
    FakeServer,
    Reply,
    rate_limited,
    retry_after_http_date,
    retry_after_seconds,
)

MODEL_BODY = {
    "request_id": "00000000-0000-4000-8000-000000000000",
    "config": {"model": "models/gemini-email", "instructions": [{"text": "system prompt"}]},
    "input": "mail body",
}


@pytest.fixture
def fake() -> Iterator[FakeServer]:
    server = FakeServer()
    yield server
    server.close()


@pytest.fixture
def gemini() -> Iterator[ModelRouterFake]:
    server = ModelRouterFake()
    yield server
    server.close()


class Counter(FakeServer):
    """An upstream with one route: POST /items stores an item, GET /items answers how many there are."""

    def __init__(self) -> None:
        super().__init__()
        self.items: list[str] = []
        self.route("POST", "/items", lambda request, _: self._add(request))
        self.route("GET", "/items", lambda request, _: Reply(200, {"count": len(self.items)}))

    def _add(self, request) -> Reply:
        self.items.append(request.body.decode())
        return Reply(200, {"count": len(self.items)})


@pytest.fixture
def counter() -> Iterator[Counter]:
    server = Counter()
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
    assert request.query == {"cursor": ["abc"]} and request.param("cursor") == "abc"
    assert request.headers["x-request-id"] == "r1"
    assert request.json() == {"a": 1}


def test_chunked_request_bodies_are_recorded(fake: FakeServer) -> None:
    fake.default("POST", "/chunked", Reply(204))
    httpx.post(f"{fake.url}/chunked", content=iter([b'{"a":', b" 1}"]))
    assert fake.received("POST", "/chunked")[0].json() == {"a": 1}


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


def test_retry_after_in_seconds_and_http_date(fake: FakeServer) -> None:
    fake.queue("GET", "/limited", rate_limited(retry_after_seconds(7)))
    fake.queue("GET", "/limited", rate_limited(retry_after_http_date(30)))

    seconds = httpx.get(f"{fake.url}/limited")
    dated = httpx.get(f"{fake.url}/limited")

    assert (seconds.status_code, seconds.headers["retry-after"]) == (429, "7")
    moment = email.utils.parsedate_to_datetime(dated.headers["retry-after"]).timestamp()
    assert dated.status_code == 429 and 28 <= moment - time.time() <= 31


def test_admin_endpoints_control_the_fake_over_http(fake: FakeServer) -> None:
    reply = {"status": 503, "body": {"down": True}, "headers": {"retry-after": "3"}}
    assert (
        httpx.post(f"{fake.url}/admin/queue", json={"method": "GET", "path": "/x", "reply": reply}).status_code == 200
    )
    queued = httpx.get(f"{fake.url}/x", headers={"x-trace": "t"})
    assert (queued.status_code, queued.json(), queued.headers["retry-after"]) == (503, {"down": True}, "3")

    [recorded] = httpx.get(f"{fake.url}/admin/state").json()["requests"]
    assert (recorded["method"], recorded["path"], recorded["headers"]["x-trace"]) == ("GET", "/x", "t")

    assert httpx.post(f"{fake.url}/admin/reset").status_code == 200
    assert httpx.get(f"{fake.url}/admin/state").json()["requests"] == []
    assert httpx.post(f"{fake.url}/admin/nope").status_code == 404


def test_model_router_records_common_wire_and_normalized_usage(gemini: ModelRouterFake) -> None:
    response = httpx.post(gemini.url + GENERATE_PATH, json=MODEL_BODY).json()
    assert response["state"] == "succeeded"
    assert response["usage"]["available"] and response["usage"]["total_tokens"] > 0
    call = gemini.calls()[0]
    assert (call.requested_model, call.system, call.user) == ("models/gemini-email", "system prompt", "mail body")


def test_model_router_queues_normalized_errors_before_default(gemini: ModelRouterFake) -> None:
    gemini.queue_generate(error_reply(429, retry_after_seconds(5)))
    response = httpx.post(gemini.url + GENERATE_PATH, json=MODEL_BODY).json()
    assert response["error"]["reason"] == "MODEL_QUOTA"
    assert response["error"]["retry_after_seconds"] == 5
    assert httpx.post(gemini.url + GENERATE_PATH, json=MODEL_BODY).json()["state"] == "succeeded"


def test_applied_reply_runs_the_route_but_answers_differently(counter: Counter) -> None:
    counter.queue("POST", "/items", Reply(500, {"error": "boom"}, applied=True))
    response = httpx.post(counter.url + "/items", content="lost")
    assert response.status_code == 500
    assert counter.items == ["lost"]


def test_pass_serves_the_route_after_a_delay_and_only_then_the_queue(counter: Counter) -> None:
    counter.items.append("seeded")
    counter.queue("GET", "/items", Reply(None, delay_ms=200))
    counter.queue("GET", "/items", Reply(500))
    started = time.monotonic()
    first = httpx.get(counter.url + "/items")
    assert first.status_code == 200 and first.json() == {"count": 1}
    assert time.monotonic() - started >= 0.2
    assert httpx.get(counter.url + "/items").status_code == 500
    assert PASS.status is None and counter.pending("GET", "/items") == 0
