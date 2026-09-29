"""In-process loopback HTTP fake for upstream APIs (Gemini, Todoist, Access JWKS).

Tests queue replies per (method, path), read back what the Worker sent, and can
make a reply hang until the client gives up, which is how outbound timeouts are
proven to really close the connection. Subclasses add routes that behave like the
real upstream; a queued reply always wins over a route, and a queued reply with
``applied=True`` runs the route first, i.e. the upstream acted but answered
differently (the response was lost, or it failed after committing).

The same controls are reachable over HTTP under ``/admin/`` (reset, queue, seed,
state), as the Go fakes offered; admin requests are never recorded.
"""

import email.utils
import json
import re
import select
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

MAX_HANG_S = 120
ADMIN_PREFIX = "/admin/"


@dataclass(frozen=True)
class Reply:
    """``status=None`` serves the route's own answer (after ``delay_ms``)."""

    status: int | None = 200
    body: bytes | str | dict | list = b""
    headers: dict[str, str] = field(default_factory=dict)
    delay_ms: int = 0
    hang: bool = False
    applied: bool = False

    def encoded(self) -> tuple[bytes, dict[str, str]]:
        headers = dict(self.headers)
        body = self.body
        if isinstance(body, dict | list):
            body = json.dumps(body, ensure_ascii=False).encode()
            headers.setdefault("content-type", "application/json")
        elif isinstance(body, str):
            body = body.encode()
        return body, headers


PASS = Reply(status=None)


def retry_after_seconds(seconds: int) -> dict[str, str]:
    return {"retry-after": str(seconds)}


def retry_after_http_date(seconds: float) -> dict[str, str]:
    """The HTTP-date form, ``seconds`` from now (whole seconds, so round up in asserts)."""
    return {"retry-after": email.utils.formatdate(time.time() + seconds, usegmt=True)}


def rate_limited(retry_after: dict[str, str], body: dict | None = None) -> Reply:
    return Reply(429, body or {"error": "rate limited"}, retry_after)


@dataclass(frozen=True)
class Recorded:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: bytes
    at: float = 0.0

    def json(self) -> Any:
        return json.loads(self.body)

    def param(self, name: str) -> str | None:
        values = self.query.get(name)
        return values[0] if values else None


Route = Callable[[Recorded, re.Match[str]], Reply]


class FakeServer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queues: dict[tuple[str, str], deque[Reply]] = defaultdict(deque)
        self._defaults: dict[tuple[str, str], Reply] = {}
        self._routes: list[tuple[str, re.Pattern[str], Route]] = []
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
        """Served whenever the queue for method and path is empty and no route matches."""
        with self._lock:
            self._defaults[method, path] = reply

    def route(self, method: str, pattern: str, handler: Route) -> None:
        """Upstream behaviour for paths fully matching ``pattern``."""
        self._routes.append((method, re.compile(pattern), handler))

    def pending(self, method: str, path: str) -> int:
        """Queued replies not served yet."""
        with self._lock:
            return len(self._queues[method, path])

    def reset(self) -> None:
        with self._lock:
            self._queues.clear()
            self._defaults.clear()
            self.requests.clear()
            self.disconnects.clear()
        self.reset_state()

    def reset_state(self) -> None:
        """Subclasses drop their upstream state here."""

    def seed(self, document: Any) -> None:
        """Subclasses load upstream state from an /admin/seed body."""
        raise NotImplementedError

    def state(self) -> dict[str, Any]:
        with self._lock:
            return {"requests": [_recorded_json(r) for r in self.requests], "disconnects": list(self.disconnects)}

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

    def authorize(self, request: Recorded) -> Reply | None:
        """A reply when the request lacks the upstream's credentials, else None."""
        return None

    def queue_keys(self, request: Recorded) -> list[tuple[str, str]]:
        """Queues consulted for a request, most specific first."""
        return [(request.method, request.path)]

    def _next_reply(self, request: Recorded) -> Reply:
        with self._lock:
            queued = next((self._queues[key].popleft() for key in self.queue_keys(request) if self._queues[key]), None)
            fallback = self._defaults.get((request.method, request.path), Reply(404, {"error": "no reply queued"}))
        if queued is not None and queued.status is not None and not queued.applied:
            return queued
        if route := self._match(request):
            handler, match = route
            answer = handler(request, match)
        else:
            answer = fallback
        if queued is None:
            return answer
        if queued.status is None:
            return replace(answer, delay_ms=queued.delay_ms, hang=queued.hang)
        return queued

    def _match(self, request: Recorded) -> tuple[Route, re.Match[str]] | None:
        for method, pattern, handler in self._routes:
            if method == request.method and (match := pattern.fullmatch(request.path)):
                return handler, match
        return None

    def _record(self, request: Recorded) -> None:
        with self._lock:
            self.requests.append(request)

    def _record_disconnect(self, path: str) -> None:
        with self._lock:
            self.disconnects.append(path)

    def _admin(self, method: str, path: str, body: bytes) -> Reply:
        document = json.loads(body) if body.strip() else {}
        match method, path.removeprefix(ADMIN_PREFIX):
            case "POST", "reset":
                self.reset()
            case "POST", "queue":
                reply = document.get("reply", {})
                self.queue(document["method"], document["path"], Reply(**reply))
            case "POST", "seed":
                self.seed(document)
            case "GET", "state":
                return Reply(200, self.state())
            case _:
                return Reply(404, {"error": "unknown admin endpoint"})
        return Reply(200, {"status": "ok"})

    def _handler_class(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _read_body(self) -> bytes:
                if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
                    chunks = []
                    while size := int(self.rfile.readline().split(b";")[0], 16):
                        chunks.append(self.rfile.read(size))
                        self.rfile.readline()
                    self.rfile.readline()
                    return b"".join(chunks)
                length = int(self.headers.get("content-length") or 0)
                return self.rfile.read(length) if length else b""

            def _serve(self) -> None:
                url = urlsplit(self.path)
                body = self._read_body()
                if url.path.startswith(ADMIN_PREFIX):
                    self._send(fake._admin(self.command, url.path, body))
                    return
                request = Recorded(
                    self.command,
                    url.path,
                    parse_qs(url.query),
                    {k.lower(): v for k, v in self.headers.items()},
                    body,
                    time.time(),
                )
                fake._record(request)
                reply = fake.authorize(request) or fake._next_reply(request)
                if reply.hang:
                    self._hang(url.path)
                    return
                if reply.delay_ms:
                    time.sleep(reply.delay_ms / 1000)
                self._send(reply)

            def _send(self, reply: Reply) -> None:
                payload, headers = reply.encoded()
                self.send_response(reply.status or 200)
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


def _recorded_json(request: Recorded) -> dict[str, Any]:
    document = asdict(request)
    document["body"] = request.body.decode(errors="replace")
    return document
