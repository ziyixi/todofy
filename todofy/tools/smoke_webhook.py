#!/usr/bin/env python3
"""Synthetic smoke test of a Todofy ``POST /hooks/mail`` endpoint.

  MAIL_WEBHOOK_TOKEN=... python3 tools/smoke_webhook.py https://todofy-hooks.ziyixi.science/hooks/mail

Sends seven requests and expects 401 (no token), 415 (wrong media type), 413
(body over 1 MiB), 400 (not an event), 204 (stored), 204 (same bytes again)
and 409 (same event_id, different bytes). The event is synthetic and carries
``needs_review=true``, so Todofy parks it for the owner without calling Gemini
or Todoist; dismiss it in the UI afterwards. Re-running is safe: the bytes are
fixed, so a stored event answers 204 again. The token is read from the
environment and never printed. Adapted from scripts/test_mail_inbox_integration.py
@ 6c46ed4; stdlib only, Python 3.9+.
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import os
import sys
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

EVENT_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"
MESSAGE_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710002"
MAX_BODY_BYTES = 1 << 20
TIMEOUT_S = 30.0


def smoke_event(text: str = "Synthetic test content.") -> dict[str, Any]:
    """A valid mail.received.v1 event that Todofy must hold for review, never summarise."""
    return {
        "type": "mail.received.v1",
        "event_id": EVENT_ID,
        "received_at": "2026-09-23T16:00:00Z",
        "message": {
            "id": MESSAGE_ID,
            "from": [{"address": "smoke@example.com", "name": "Todofy smoke test"}],
            "to": [{"address": "todofy@example.com", "name": ""}],
            "subject": "Todofy synthetic smoke test",
            "sent_at": None,
            "rfc_message_id": None,
            "text": text,
            "attachments": [],
            "needs_review": True,
            "warnings": ["synthetic_smoke_test"],
            "content_policy_version": "storage-v1",
        },
    }


def encode(event: dict[str, Any]) -> bytes:
    return json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode()


def post(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    parts = urlsplit(url)
    connection_class = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    connection = connection_class(parts.hostname or "", parts.port, timeout=TIMEOUT_S)
    try:
        # The server may answer 413 and close before reading the whole body.
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            connection.request("POST", parts.path or "/", body=body, headers=headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def error_code(body: bytes) -> str:
    try:
        return str(json.loads(body)["error"]["code"])
    except (ValueError, KeyError, TypeError):
        return "-"


Step = tuple[str, int, bytes, dict[str, str]]


def steps(token: str, host: str | None) -> list[Step]:
    base = {"Content-Type": "application/json", "Idempotency-Key": EVENT_ID}
    if host:
        base["Host"] = host
    authed = {**base, "Authorization": f"Bearer {token}"}
    payload = encode(smoke_event())
    conflict = encode(smoke_event("Conflicting synthetic test content."))
    return [
        ("no token", 401, payload, base),
        ("wrong media type", 415, payload, {**authed, "Content-Type": "text/plain"}),
        ("body over 1 MiB", 413, b" " * (MAX_BODY_BYTES + 1), authed),
        ("not an event", 400, b"{}", authed),
        ("stored", 204, payload, authed),
        ("same bytes again", 204, payload, authed),
        ("same event_id, different bytes", 409, conflict, authed),
    ]


def run(url: str, token: str, host: str | None = None, *, send: Callable[..., tuple[int, bytes]] = post) -> bool:
    passed = True
    for number, (name, expected, body, headers) in enumerate(steps(token, host), 1):
        status, response = send(url, body, headers)
        ok = status == expected
        passed &= ok
        suffix = "" if ok else f" (expected {expected}, error code {error_code(response)})"
        print(f"{number}. {name}: {status} {'ok' if ok else 'FAIL'}{suffix}")
        if not ok:
            break
    print("smoke PASS" if passed else "smoke FAIL")
    return passed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("url", help="full webhook URL, e.g. https://todofy-hooks.example.com/hooks/mail")
    parser.add_argument("--host", help="Host header override (local wrangler dev: todofy-hooks.localhost)")
    args = parser.parse_args(argv)
    token = os.environ.get("MAIL_WEBHOOK_TOKEN", "")
    if not token:
        print("MAIL_WEBHOOK_TOKEN is not set", file=sys.stderr)
        return 2
    try:
        return 0 if run(args.url, token, args.host) else 1
    except (OSError, http.client.HTTPException) as error:
        print(f"smoke FAIL: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
