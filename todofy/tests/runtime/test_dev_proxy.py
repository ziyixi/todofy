"""The harness's guard against wrangler dev's 5 s keep-alive race (harness._DevProxyTransport, docs/dev-notes.md).

No workerd: a loopback fake stands in for the dev server, so the test shows which requests the harness sends, in
which order, and that it never sends one twice.
"""

from pathlib import Path

from tests.fakes.server import FakeServer
from tests.runtime.harness import HOOKS_HOST, PROXY_IDLE_S, PUBLIC_HOST, Worker


def test_only_a_request_the_proxy_would_not_resend_after_a_pause_is_preceded_by_a_health_get(tmp_path: Path) -> None:
    fake = FakeServer()  # answers 404 to everything
    worker = Worker([], "", tmp_path, {})
    worker.base_url = fake.url
    try:
        with worker.client(PUBLIC_HOST) as client:
            client.get("/a")
            client.post("/b", content=b"{}")  # right after an answer: sent as it is
            worker.answered_at -= 2 * PROXY_IDLE_S
            client.get("/c")  # a GET the proxy resends itself
            worker.answered_at -= 2 * PROXY_IDLE_S
            client.post("/d", content=b"{}")
        worker.answered_at -= 2 * PROXY_IDLE_S
        assert worker.headers_only_status(HOOKS_HOST, "POST", "/e", {"content-length": "0"}) == 404
        sent = [(r.method, r.path, r.headers["host"]) for r in fake.received()]
        assert sent == [
            ("GET", "/a", PUBLIC_HOST),
            ("POST", "/b", PUBLIC_HOST),
            ("GET", "/c", PUBLIC_HOST),
            ("GET", "/health", HOOKS_HOST),
            ("POST", "/d", PUBLIC_HOST),
            ("GET", "/health", HOOKS_HOST),
            ("POST", "/e", HOOKS_HOST),
        ]
    finally:
        fake.close()
