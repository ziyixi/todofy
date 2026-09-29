"""smoke_webhook.py against a loopback stand-in for /hooks/mail with the lead's rules."""

import hashlib
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import pytest

from todofy.core.contract import ContractError, parse_mail_event
from tools import smoke_webhook

TOKEN = "smoke-test-token"


class Hooks(BaseHTTPRequestHandler):
    """Auth, then media type, then the 1 MiB cap, then the contract and the ledger."""

    stored: ClassVar[dict[str, str]] = {}
    hosts: ClassVar[list[str]] = []

    def do_POST(self) -> None:
        self.hosts.append(self.headers.get("host", ""))
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.reply(401, "unauthorized")
        if self.headers.get("content-type") != "application/json":
            return self.reply(415, "unsupported_media_type")
        if int(self.headers.get("content-length", "0")) > smoke_webhook.MAX_BODY_BYTES:
            return self.reply(413, "payload_too_large")
        body = self.rfile.read(int(self.headers["content-length"]))
        try:
            event = parse_mail_event(body)
        except ContractError:
            return self.reply(400, "invalid_event")
        if self.headers.get("idempotency-key") != event.event_id:
            return self.reply(400, "invalid_event")
        digest = hashlib.sha256(body).hexdigest()
        if self.stored.setdefault(event.event_id, digest) != digest:
            return self.reply(409, "event_conflict")
        self.reply(204, "")

    def reply(self, status: int, code: str) -> None:
        body = json.dumps({"error": {"code": code}}).encode() if code else b""
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def hooks_url() -> Iterator[str]:
    Hooks.stored, Hooks.hosts = {}, []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Hooks)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/hooks/mail"
    server.shutdown()
    server.server_close()


def test_smoke_event_is_a_valid_needs_review_event() -> None:
    event = parse_mail_event(smoke_webhook.encode(smoke_webhook.smoke_event()))
    assert event.needs_review and event.unreadable
    assert event.event_id == smoke_webhook.EVENT_ID


def test_passes_twice_against_a_conforming_endpoint(
    hooks_url: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MAIL_WEBHOOK_TOKEN", TOKEN)
    assert smoke_webhook.main([hooks_url, "--host", "todofy-hooks.localhost"]) == 0
    assert smoke_webhook.main([hooks_url]) == 0  # the fixed bytes make a re-run pass
    out = capsys.readouterr().out
    assert [line.split(": ")[1] for line in out.splitlines()[:7]] == [
        "401 ok",
        "415 ok",
        "413 ok",
        "400 ok",
        "204 ok",
        "204 ok",
        "409 ok",
    ]
    assert TOKEN not in out
    assert Hooks.hosts[0] == "todofy-hooks.localhost"


def test_reports_the_first_mismatch(
    hooks_url: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MAIL_WEBHOOK_TOKEN", "wrong-token")
    assert smoke_webhook.main([hooks_url]) == 1
    out = capsys.readouterr().out
    assert "2. wrong media type: 401 FAIL (expected 415, error code unauthorized)" in out
    assert "wrong-token" not in out and out.rstrip().endswith("smoke FAIL")


def test_needs_a_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MAIL_WEBHOOK_TOKEN", raising=False)
    assert smoke_webhook.main(["http://127.0.0.1:9/hooks/mail"]) == 2
