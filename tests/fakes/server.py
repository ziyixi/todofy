"""In-process loopback HTTP fake for upstream APIs (Gemini, Todoist, Access JWKS).

Tests queue replies per (method, path), read back what the Worker sent, and can
make a reply hang until the client gives up, which is how outbound timeouts are
proven to really close the connection.
"""

import json
import select
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

MAX_HANG_S = 120


@dataclass(frozen=True)
class Reply:
    status: int = 200
    body: bytes | str | dict | list = b""
    headers: dict[str, str] = field(default_factory=dict)
    delay_ms: int = 0
    hang: bool = False

    def encoded(self) -> tuple[bytes, dict[str, str]]:
        headers = dict(self.headers)
        body = self.body
        if isinstance(body, dict | list):
            body = json.dumps(body).encode()
            headers.setdefault("content-type", "application/json")
        elif isinstance(body, str):
            body = body.encode()
        return body, headers


@dataclass(frozen=True)
class Recorded:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)


class FakeServer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queues: dict[tuple[str, str], deque[Reply]] = defaultdict(deque)
        self._defaults: dict[tuple[str, str], Reply] = {}
        self._stop = threading.Event()
        self.requests: list[Recorded] = []
        self.disconnects: list[str] = []
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._handler_class())
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def queue(self, method: str, path: str, reply: Reply) -> None:
        """Replies for the same method and path are served first in, first out."""
        with self._lock:
            self._queues[method, path].append(reply)

    def default(self, method: str, path: str, reply: Reply) -> None:
        """Served whenever the queue for method and path is empty."""
        with self._lock:
            self._defaults[method, path] = reply

    def reset(self) -> None:
        with self._lock:
            self._queues.clear()
            self._defaults.clear()
            self.requests.clear()
            self.disconnects.clear()

    def received(self, method: str | None = None, path: str | None = None) -> list[Recorded]:
        with self._lock:
            return [
                r for r in self.requests if (method is None or r.method == method) and (path is None or r.path == path)
            ]

    def wait_for(self, condition: Callable[[], Any], timeout_s: float = 10) -> Any:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if result := condition():
                return result
            time.sleep(0.05)
        raise TimeoutError("fake server condition not met in time")

    def close(self) -> None:
        self._stop.set()
        self._httpd.shutdown()
        self._httpd.server_close()

    def _next_reply(self, method: str, path: str) -> Reply:
        with self._lock:
            queue = self._queues[method, path]
            if queue:
                return queue.popleft()
            return self._defaults.get((method, path), Reply(404, {"error": "no reply queued"}))

    def _record(self, request: Recorded) -> None:
        with self._lock:
            self.requests.append(request)

    def _record_disconnect(self, path: str) -> None:
        with self._lock:
            self.disconnects.append(path)

    def _handler_class(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _serve(self) -> None:
                url = urlsplit(self.path)
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                fake._record(
                    Recorded(
                        self.command,
                        url.path,
                        parse_qs(url.query),
                        {k.lower(): v for k, v in self.headers.items()},
                        body,
                    )
                )
                reply = fake._next_reply(self.command, url.path)
                if reply.hang:
                    self._hang(url.path)
                    return
                if reply.delay_ms:
                    time.sleep(reply.delay_ms / 1000)
                payload, headers = reply.encoded()
                self.send_response(reply.status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def _hang(self, path: str) -> None:
                self.close_connection = True
                deadline = time.monotonic() + MAX_HANG_S
                while not fake._stop.is_set() and time.monotonic() < deadline:
                    readable, _, _ = select.select([self.connection], [], [], 0.05)
                    if readable and not self.connection.recv(1):
                        fake._record_disconnect(path)
                        return

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _serve

            def log_message(self, format: str, *args: Any) -> None:
                pass

        return Handler
