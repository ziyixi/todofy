"""Runtime-test harness: real workerd (D1, Durable Object, alarms, cron, assets)
started with `pywrangler dev` against loopback fakes.

A test server is one process running both Workers (docs/gateway-contract.md §7): the
TypeScript gateway (primary: port, cron, assets, `--var`) and todofy-core, whose vars
go into a generated config because `--var` reaches only the primary.
"""

import base64
import functools
import hashlib
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import tomllib
import uuid
from collections.abc import Callable, Collection, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from tests.fakes.server import FakeServer, Reply

ROOT = Path(__file__).resolve().parents[2]
WRANGLER = ROOT / "node_modules" / ".bin" / "wrangler"
PYODIDE_CACHE = ROOT / ".wrangler" / "pyodide-cache"
STARTUP_TIMEOUT_S = 120
GATEWAY_CONFIG = "gateway/wrangler.test.toml"
GATEWAY_AUTH_CONFIG = "gateway/wrangler.test-auth.toml"
CORE_CONFIG = ROOT / "wrangler.test.toml"
# Vars only the gateway reads; SHARED_VARS go to both Workers, everything else to the core.
GATEWAY_VARS = re.compile(
    r"TODOFY_HOOKS_HOSTS|ACCESS_\w+|CSRF_SIGNING_KEY|MAIL_WEBHOOK_TOKEN_SHA256\w*|REPORT_BASIC_AUTH_SHA256"
    r"|DEV_\w+|JWKS_REFRESH_COOLDOWN_MS"
)
SHARED_VARS = {"MAINTENANCE_MODE", "BUILD_SHA", "TODOFY_PUBLIC_HOST"}
PUBLIC_HOST = "todofy.localhost"
HOOKS_HOST = "todofy-hooks.localhost"
ORIGIN = f"http://{PUBLIC_HOST}"
OWNER = "owner@example.com"
AUDIENCE = "test-audience"
WEBHOOK_TOKEN = "runtime-test-token"
PREVIOUS_WEBHOOK_TOKEN = "runtime-test-token-previous"
AUTH = {"authorization": f"Bearer {WEBHOOK_TOKEN}", "content-type": "application/json"}
REPORT_USER = "newsletter"
REPORT_PASSWORD = "runtime-report-password"
CSRF_SIGNING_KEY = "3d" * 32


def sha256_hex(data: str | bytes) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _ensure_assets() -> None:
    """wrangler needs the assets directory; CI builds web/ first, otherwise use a placeholder
    with one hashed-style asset (the cache-header scenarios need a file under /assets/)."""
    dist = ROOT / "uiassets" / "dist"
    if not (dist / "index.html").exists():
        (dist / "assets").mkdir(parents=True, exist_ok=True)
        (dist / "assets" / "placeholder-0000test.js").write_text("export {};\n")
        (dist / "index.html").write_text("<!doctype html><title>Todofy test placeholder</title>\n")


@functools.cache
def _cached_workerd() -> Path:
    """A workerd launcher with a Pyodide disk cache.

    Without one, every workerd start downloads the ~14 MB Pyodide bundle from
    pyodide-capnp-bin.edgeworker.net (wrangler 4.142 passes no cache flag), and a
    slow or dropped download stalls or kills the dev server. Miniflare runs the
    binary named by MINIFLARE_WORKERD_PATH.
    """
    # The same platform binary miniflare would pick.
    workerd = subprocess.run(
        ["node", "-p", "require('workerd').default"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    PYODIDE_CACHE.mkdir(parents=True, exist_ok=True)
    cache = shlex.quote(str(PYODIDE_CACHE))
    script = (
        "#!/bin/sh\n"
        f'exec {shlex.quote(workerd)} "$@"'
        f" --pyodide-bundle-disk-cache-dir={cache} --pyodide-package-disk-cache-dir={cache}\n"
    )
    launcher = PYODIDE_CACHE.parent / "workerd-with-pyodide-cache"
    if not launcher.exists() or launcher.read_text() != script:
        staged = launcher.with_suffix(f".{os.getpid()}")
        staged.write_text(script)
        staged.chmod(0o755)
        staged.replace(launcher)
    return launcher


def _wrangler(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(WRANGLER), *args],
        cwd=ROOT,
        env=os.environ | {"CI": "true", "WRANGLER_SEND_METRICS": "false"},
        capture_output=True,
        text=True,
        check=True,
    )


def wait_until[T](probe: Callable[[], T | None], timeout_s: float, what: str) -> T:
    deadline = time.monotonic() + timeout_s
    while True:
        if (result := probe()) is not None:
            return result
        if time.monotonic() > deadline:
            raise TimeoutError(what)
        time.sleep(0.1)


class Worker:
    """One `pywrangler dev` process on its own port and persist directory.

    ``configs`` are passed in order (the first is the primary, which owns the port, the cron
    trigger, the assets and every ``--var``); ``d1_config`` names the config whose D1
    binding the Worker writes. ``stop(kill=True)`` then ``start()`` models an evicted
    isolate: workerd dies mid-call, D1 and the Durable Object's storage survive on disk.
    """

    def __init__(self, configs: list[str], d1_config: str, persist_to: Path, variables: dict[str, str]) -> None:
        self.configs = configs
        self.d1_config = d1_config
        self.persist_to = persist_to
        self.variables = variables
        self.base_url = ""
        self._process: subprocess.Popen[bytes] | None = None
        self._csrf: dict[str, str] | None = None
        self.hooks = self.owner = httpx.Client()  # host-bound clients replace it in start()

    def client(self, host: str) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, headers={"host": host}, timeout=30)

    def start(self) -> None:
        port = _free_port()
        command = [sys.executable, "-m", "pywrangler", "dev"]
        for config in self.configs:
            command += ["--config", config]
        command += [
            "--ip",
            "127.0.0.1",
            "--port",
            str(port),
            "--persist-to",
            str(self.persist_to),
            "--show-interactive-dev-session=false",
        ]
        for name, value in self.variables.items():
            command += ["--var", f"{name}:{value}"]
        log_path = self.persist_to / "dev.log"
        with log_path.open("a") as log:
            self._process = subprocess.Popen(
                command,
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                env=os.environ
                | {
                    "CI": "true",
                    "WRANGLER_SEND_METRICS": "false",
                    "MINIFLARE_WORKERD_PATH": str(_cached_workerd()),
                    # A private dev registry: the gateway's todofy-core binding must never reach
                    # another test server's core (or a missing core must stay missing).
                    "WRANGLER_REGISTRY_PATH": str(self.persist_to / "registry"),
                },
            )
        self.base_url = f"http://127.0.0.1:{port}"
        self.hooks, self.owner = self.client(HOOKS_HOST), self.client(PUBLIC_HOST)
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        while True:
            if self._process.poll() is not None or time.monotonic() > deadline:
                self.stop(kill=True)
                pytest.fail(f"{self.configs} did not start:\n{log_path.read_text()[-4000:]}")
            try:
                if self.hooks.get("/health").status_code == 200:
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.25)

    def stop(self, kill: bool = False) -> None:
        self.hooks.close()
        self.owner.close()
        if self._process is None:
            return
        try:
            os.killpg(self._process.pid, signal.SIGKILL if kill else signal.SIGTERM)
            self._process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(self._process.pid, signal.SIGKILL)
            self._process.wait(timeout=15)
        except ProcessLookupError:
            pass  # it already exited, e.g. workerd failed to start; keep that failure visible
        self._process = None

    def crash_and_restart(self, lose_object_storage: bool = False) -> None:
        """Kill workerd mid-flight; optionally also lose the Durable Object's storage."""
        self.stop(kill=True)
        if lose_object_storage:
            files = [path for path in (self.persist_to / "v3" / "do").rglob("*") if path.is_file()]
            assert files, "no Durable Object storage found to delete"
            for path in files:
                path.unlink()
        self.start()

    def headers_only_status(self, host: str, method: str, path: str, headers: dict[str, str]) -> int:
        """Send a request head without its body and return the response status."""
        port = int(self.base_url.rsplit(":", 1)[1])
        lines = [f"{method} {path} HTTP/1.1", f"Host: {host}", "Connection: close"]
        lines += [f"{name}: {value}" for name, value in headers.items()]
        with socket.create_connection(("127.0.0.1", port), timeout=30) as sock:
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            return int(sock.recv(64).split(b" ")[1])

    def trigger_cron(self, cron: str = "*/10 * * * *") -> httpx.Response:
        return httpx.get(f"{self.base_url}/cdn-cgi/local/scheduled", params={"cron": cron}, timeout=30)

    def d1(self, sql: str) -> list[dict[str, Any]]:
        # A second process reads the SQLite file workerd is writing (the alarm may be mid-step), and
        # wrangler sets no busy timeout, so a read can hit a transient lock; retry only that case.
        args = ("d1", "execute", "DB", "--local", "--persist-to", str(self.persist_to), "--config", self.d1_config)
        for attempt in range(5):
            try:
                result = _wrangler(*args, "--json", "--command", sql)
            except subprocess.CalledProcessError as error:
                output = f"{error.stdout}\n{error.stderr}"
                if attempt < 4 and ("SQLITE_BUSY" in output or "database is locked" in output):
                    time.sleep(0.5)
                    continue
                raise AssertionError(f"wrangler d1 execute failed: {output.strip()[-2000:]}") from error
            return json.loads(result.stdout)[-1]["results"]
        raise AssertionError("unreachable")

    # Mail Hero side.

    def post_event(
        self,
        body: bytes,
        event_id: str | None = None,
        *,
        token: str = WEBHOOK_TOKEN,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        """POST /hooks/mail the way Mail Hero sends it: Bearer, JSON and Idempotency-Key."""
        key = event_id if event_id is not None else json.loads(body)["event_id"]
        sent = {"authorization": f"Bearer {token}", "content-type": "application/json", "idempotency-key": key}
        return self.hooks.post("/hooks/mail", content=body, headers=sent | (headers or {}))

    # Owner side (DEV_AUTH_BYPASS, or an Access JWT in `headers`).

    def event(self, event_id: str) -> dict[str, Any] | None:
        response = self.owner.get(f"/api/v1/events/{event_id}")
        if response.status_code == 404:
            return None
        assert response.status_code == 200, response.text
        return response.json()

    def wait_event(
        self,
        event_id: str,
        until: Collection[str] | Callable[[dict[str, Any]], bool],
        timeout_s: float = 30,
    ) -> dict[str, Any]:
        """Poll the event until its state is in ``until`` (or ``until(event)`` holds)."""
        accept = until if callable(until) else (lambda event: event["state"] in until)
        last: list[dict[str, Any] | None] = [None]

        def probe() -> dict[str, Any] | None:
            last[0] = self.event(event_id)
            return last[0] if last[0] is not None and accept(last[0]) else None

        try:
            return wait_until(probe, timeout_s, event_id)
        except TimeoutError:
            pytest.fail(f"event {event_id} never reached {until}: {last[0]}")

    def csrf_headers(self) -> dict[str, str]:
        """What a same-origin browser POST carries (cookie set by hand: it is Secure)."""
        if self._csrf is None:
            response = self.owner.get("/api/v1/csrf")
            assert response.status_code == 200, response.text
            token = response.json()["token"]
            self._csrf = {"origin": ORIGIN, "x-csrf-token": token, "cookie": f"todofy_csrf={token}"}
        return self._csrf

    def post_owner(self, path: str, body: dict[str, Any], headers: dict[str, str] | None = None) -> httpx.Response:
        return self.owner.post(path, json=body, headers=self.csrf_headers() | (headers or {}))

    def reconcile(
        self,
        event_id: str,
        action: str,
        *,
        version: int | None = None,
        task_id: str | None = None,
        action_request_id: str | None = None,
    ) -> httpx.Response:
        if version is None:
            version = (self.event(event_id) or {}).get("version", 1)
        body: dict[str, Any] = {
            "action": action,
            "version": version,
            "action_request_id": action_request_id or str(uuid.uuid4()),
        }
        if task_id is not None:
            body["task_id"] = task_id
        return self.post_owner(f"/api/v1/events/{event_id}/reconcile", body)

    def overview(self) -> dict[str, Any]:
        response = self.owner.get("/api/v1/overview")
        assert response.status_code == 200, response.text
        return response.json()

    # Newsletter side.

    def report(
        self, path: str, params: dict[str, str] | None = None, auth: tuple[str, str] | None = None
    ) -> httpx.Response:
        return self.hooks.get(path, params=params, auth=auth or (REPORT_USER, REPORT_PASSWORD))


def _run(worker: Worker) -> Iterator[Worker]:
    _ensure_assets()
    if any((ROOT / "migrations").glob("*.sql")):
        state = str(worker.persist_to)
        _wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", worker.d1_config)
    try:
        worker.start()
        yield worker
    finally:
        worker.stop()


def start_worker(config: str, state: Path, variables: dict[str, str]) -> Iterator[Worker]:
    """A single Worker (the test-only probes); every var goes to it."""
    yield from _run(Worker([config], config, state, variables))


def start_gateway(
    state: Path, variables: dict[str, str], config: str = GATEWAY_CONFIG, core: bool = True
) -> Iterator[Worker]:
    """The gateway (``config``, the primary) with todofy-core in one process; ``core=False``
    starts the gateway alone, so every Durable Object call fails.

    Gateway vars stay ``--var``; core vars are written with the core test config into a
    ``wrangler.test-run-<uuid>.json`` at the repo root (a Python config must sit next to
    ``python_modules/``), removed when the Worker stops for good.
    """
    shared = {name: value for name, value in variables.items() if name in SHARED_VARS}
    gateway = {name: value for name, value in variables.items() if GATEWAY_VARS.fullmatch(name)} | shared
    if not core:
        yield from _run(Worker([config], str(CORE_CONFIG), state, gateway))
        return
    core_config = tomllib.loads(CORE_CONFIG.read_text())
    core_config["vars"] |= {name: value for name, value in variables.items() if name not in gateway} | shared
    generated = ROOT / f"wrangler.test-run-{uuid.uuid4().hex}.json"
    generated.write_text(json.dumps(core_config))
    try:
        yield from _run(Worker([config, generated.name], generated.name, state, gateway))
    finally:
        generated.unlink(missing_ok=True)


def utc_now() -> str:
    """Mail Hero's timestamp form: ``Date.prototype.toISOString`` (milliseconds, ``Z``)."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def mail_event(
    event_id: str | None = None,
    *,
    subject: str = "合成测试邮件",
    text: str | None = None,
    size: int | None = None,
    **message: Any,
) -> tuple[str, bytes]:
    """A valid synthetic mail.received.v1 event. The default body carries the event ID,
    so fake upstream calls can be matched to it; ``size`` pads the exact byte length
    with a field the contract ignores."""
    event_id = event_id or str(uuid.uuid4())
    document = {
        "type": "mail.received.v1",
        "event_id": event_id,
        "received_at": utc_now(),
        "message": {
            "id": str(uuid.uuid4()),
            "from": [{"address": "sender@example.org", "name": "Sender"}],
            "to": [{"address": "owner@example.org", "name": ""}],
            "subject": subject,
            "sent_at": None,
            "rfc_message_id": None,
            "text": f"合成正文 marker {event_id}" if text is None else text,
            "attachments": [],
        }
        | message,
    }
    body = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
    if size is not None:
        padded = document | {"x_padding": ""}
        body = json.dumps(padded, ensure_ascii=False, separators=(",", ":")).encode()
        body = body[:-2] + b"x" * (size - len(body)) + b'"}'
    return event_id, body


def settled_reminder(worker: Worker) -> dict[str, Any] | None:
    """Today's reminder row once its Todoist call has an outcome (newest day first)."""
    response = worker.owner.get("/api/v1/reminders")
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    today = datetime.now(UTC).date().isoformat()
    return items[0] if items and items[0]["day"] == today and items[0]["state"] != "sending" else None


def transitions(event: dict[str, Any]) -> list[tuple[str | None, str, str | None, str]]:
    return [(t["from_state"], t["to_state"], t["error_code"], t["actor"]) for t in event["transitions"]]


class AccessIssuer:
    """Loopback stand-in for <team>.cloudflareaccess.com: serves JWKS and signs tokens."""

    def __init__(self) -> None:
        self.server = FakeServer()
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.jwks = [self._jwk(self.key, "test-key")]
        self.server.default("GET", "/cdn-cgi/access/certs", Reply(200, {"keys": self.jwks}))

    @staticmethod
    def _jwk(key: rsa.RSAPrivateKey, kid: str) -> dict[str, str]:
        numbers = key.public_key().public_numbers()
        return {
            "kty": "RSA",
            "kid": kid,
            "alg": "RS256",
            "use": "sig",
            "n": _b64url(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")),
            "e": _b64url(numbers.e.to_bytes(3, "big")),
        }

    def rotate(self, kid: str) -> rsa.RSAPrivateKey:
        """Publish a new current key ahead of the old one, as Access does on rotation; returns it."""
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.jwks = [self._jwk(key, kid), *self.jwks]
        self.server.default("GET", "/cdn-cgi/access/certs", Reply(200, {"keys": self.jwks}))
        return key

    @property
    def url(self) -> str:
        return self.server.url

    def token(
        self, key: rsa.RSAPrivateKey | None = None, alg: str = "RS256", kid: str = "test-key", **overrides: Any
    ) -> str:
        now = int(time.time())
        claims = {
            "iss": self.url,
            "aud": [AUDIENCE],
            "email": OWNER,
            "sub": "owner-id",
            "iat": now,
            "exp": now + 600,
        } | overrides
        header = _b64url(json.dumps({"alg": alg, "kid": kid, "typ": "JWT"}).encode())
        payload = _b64url(json.dumps({k: v for k, v in claims.items() if v is not None}).encode())
        signing_input = f"{header}.{payload}".encode()
        signature = (key or self.key).sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        return f"{header}.{payload}.{_b64url(signature)}"


def error_code(response: httpx.Response) -> str:
    return response.json()["error"]["code"]
