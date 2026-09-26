#!/usr/bin/env python3
"""Check the isolated Docker CI inbox with a synthetic, ignored event."""

import base64
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "http://127.0.0.1:10003"
EVENT_ID = "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001"
TOKEN = (ROOT / "testdata/mail-webhook-test-token").read_text().strip()
BASIC = base64.b64encode(b"testuser:testpassword").decode()


def request(path, data=None, headers=None):
    req = urllib.request.Request(ORIGIN + path, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read()


def expect_status(wanted, path, data=None, headers=None):
    actual, body = request(path, data, headers)
    assert actual == wanted, f"{path}: expected {wanted}, got {actual}"
    return body


def main():
    event = {
        "type": "mail.received.v1",
        "event_id": EVENT_ID,
        "received_at": "2026-09-23T16:00:00Z",
        "message": {
            "id": "f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710002",
            "from": [],
            "to": [],
            # The worker intentionally ignores this prefix before any LLM or
            # Todoist call. All other fields satisfy the public wire contract.
            "subject": "[Todofy System] Synthetic inbox persistence test",
            "sent_at": None,
            "rfc_message_id": None,
            "text": "Synthetic test content.",
            "attachments": [],
        },
    }
    payload = json.dumps(event, separators=(",", ":")).encode()
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
        "Idempotency-Key": EVENT_ID,
    }
    expect_status(401, "/hooks/mail", payload)
    expect_status(204, "/hooks/mail", payload, headers)
    expect_status(204, "/hooks/mail", payload, headers)
    event["message"]["text"] = "Conflicting synthetic test content."
    conflict = json.dumps(event, separators=(",", ":")).encode()
    expect_status(409, "/hooks/mail", conflict, headers)

    subprocess.run(
        ["docker", "compose", "-f", "docker-compose.test.yml", "restart", "todofy"],
        cwd=ROOT, check=True, capture_output=True,
    )
    for attempt in range(30):
        try:
            status, _ = request("/health")
            if status == 200:
                break
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)
    else:
        raise AssertionError("Synthetic Todofy container did not restart")

    expect_status(204, "/hooks/mail", payload, headers)
    expect_status(409, "/hooks/mail", conflict, headers)
    for attempt in range(20):
        body = expect_status(
            200, "/api/v1/mail_inbox", headers={"Authorization": "Basic " + BASIC},
        )
        items = json.loads(body)["items"]
        assert len(items) == 1 and items[0]["event_id"] == EVENT_ID
        if items[0]["state"] == "ignored":
            assert not items[0]["task_id"]
            print("Synthetic inbox passed: durable ACK, duplicate/conflict, restart, no task.")
            return
        time.sleep(0.5)
    raise AssertionError("Synthetic inbox event did not reach ignored state")


if __name__ == "__main__":
    main()
