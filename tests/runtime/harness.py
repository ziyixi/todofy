"""Runtime-test harness: real workerd (D1, Durable Object, alarms, cron, assets)
started with `pywrangler dev` against loopback fakes."""

import base64
import json
import os
import signal
import socket
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from tests.fakes.server import FakeServer, Reply

ROOT = Path(__file__).resolve().parents[2]
WRANGLER = ROOT / "node_modules" / ".bin" / "wrangler"
STARTUP_TIMEOUT_S = 120
PUBLIC_HOST = "todofy.localhost"
HOOKS_HOST = "todofy-hooks.localhost"
OWNER = "owner@example.com"
AUDIENCE = "test-audience"
WEBHOOK_TOKEN = "runtime-test-token"
AUTH = {"authorization": f"Bearer {WEBHOOK_TOKEN}", "content-type": "application/json"}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _ensure_assets() -> None:
    """wrangler needs the assets directory; CI builds web/ first, otherwise use a placeholder."""
    index = ROOT / "uiassets" / "dist" / "index.html"
    if not index.exists():
        index.parent.mkdir(parents=True, exist_ok=True)
        index.write_text("<!doctype html><title>Todofy test placeholder</title>\n")


def _wrangler(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(WRANGLER), *args],
        cwd=ROOT,
        env=os.environ | {"CI": "true", "WRANGLER_SEND_METRICS": "false"},
        capture_output=True,
        text=True,
        check=True,
    )


class Worker:
    def __init__(self, base_url: str, config: str, persist_to: Path) -> None:
        self.base_url = base_url
        self.config = config
        self.persist_to = persist_to
        self.hooks = self.client(HOOKS_HOST)
        self.owner = self.client(PUBLIC_HOST)

    def client(self, host: str) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, headers={"host": host}, timeout=30)

    def close(self) -> None:
        self.hooks.close()
        self.owner.close()

    def headers_only_status(self, host: str, method: str, path: str, headers: dict[str, str]) -> int:
        """Send a request head without its body and return the response status."""
        port = int(self.base_url.rsplit(":", 1)[1])
        lines = [f"{method} {path} HTTP/1.1", f"Host: {host}", "Connection: close"]
        lines += [f"{name}: {value}" for name, value in headers.items()]
        with socket.create_connection(("127.0.0.1", port), timeout=30) as sock:
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            return int(sock.recv(64).split(b" ")[1])

    def trigger_cron(self, cron: str) -> httpx.Response:
        return httpx.get(f"{self.base_url}/cdn-cgi/local/scheduled", params={"cron": cron}, timeout=30)

    def d1(self, sql: str) -> list[dict[str, Any]]:
        result = _wrangler(
            "d1",
            "execute",
            "DB",
            "--local",
            "--persist-to",
            str(self.persist_to),
            "--config",
            self.config,
            "--json",
            "--command",
            sql,
        )
        return json.loads(result.stdout)[0]["results"]


def start_worker(config: str, state: Path, variables: dict[str, str]) -> Iterator[Worker]:
    _ensure_assets()
    if any((ROOT / "migrations").glob("*.sql")):
        _wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", str(state), "--config", config)

    port = _free_port()
    command = [
        sys.executable,
        "-m",
        "pywrangler",
        "dev",
        "--config",
        config,
        "--ip",
        "127.0.0.1",
        "--port",
        str(port),
        "--persist-to",
        str(state),
        "--show-interactive-dev-session=false",
    ]
    for name, value in variables.items():
        command += ["--var", f"{name}:{value}"]
    log_path = state / "dev.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=os.environ | {"CI": "true", "WRANGLER_SEND_METRICS": "false"},
        )
    worker = Worker(f"http://127.0.0.1:{port}", config, state)
    try:
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        while True:
            if process.poll() is not None or time.monotonic() > deadline:
                pytest.fail(f"{config} did not start:\n{log_path.read_text()[-4000:]}")
            try:
                if worker.hooks.get("/health").status_code == 200:
                    break
            except httpx.TransportError:
                pass
            time.sleep(0.25)
        yield worker
    finally:
        worker.close()
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)


class AccessIssuer:
    """Loopback stand-in for <team>.cloudflareaccess.com: serves JWKS and signs tokens."""

    def __init__(self) -> None:
        self.server = FakeServer()
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        numbers = self.key.public_key().public_numbers()
        jwk = {
            "kty": "RSA",
            "kid": "test-key",
            "alg": "RS256",
            "use": "sig",
            "n": _b64url(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")),
            "e": _b64url(numbers.e.to_bytes(3, "big")),
        }
        self.server.default("GET", "/cdn-cgi/access/certs", Reply(200, {"keys": [jwk]}))

    @property
    def url(self) -> str:
        return self.server.url

    def token(self, key: rsa.RSAPrivateKey | None = None, alg: str = "RS256", **overrides: Any) -> str:
        now = int(time.time())
        claims = {
            "iss": self.url,
            "aud": [AUDIENCE],
            "email": OWNER,
            "sub": "owner-id",
            "iat": now,
            "exp": now + 600,
        } | overrides
        header = _b64url(json.dumps({"alg": alg, "kid": "test-key", "typ": "JWT"}).encode())
        payload = _b64url(json.dumps({k: v for k, v in claims.items() if v is not None}).encode())
        signing_input = f"{header}.{payload}".encode()
        signature = (key or self.key).sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        return f"{header}.{payload}.{_b64url(signature)}"


def error_code(response: httpx.Response) -> str:
    return response.json()["error"]["code"]


def event_body(size: int | None = None, **fields: Any) -> tuple[str, bytes]:
    """A synthetic event, padded with a filler field to exactly `size` bytes."""
    event_id = fields.pop("event_id", str(uuid.uuid4()))
    body = json.dumps({"event_id": event_id, **fields, "filler": ""}).encode()
    if size is not None:
        body = body[:-2] + b"x" * (size - len(body)) + b'"}'
    return event_id, body


def spike_event(
    owner: httpx.Client, event_id: str, *, until_not: str | None = None, timeout_s: float = 15
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while True:
        response = owner.get(f"/api/v1/spike/events/{event_id}")
        if response.status_code == 200 and (until_not is None or response.json()["state"] != until_not):
            return response.json()
        if time.monotonic() > deadline:
            raise TimeoutError(f"event {event_id}: {response.status_code} {response.text}")
        time.sleep(0.1)
