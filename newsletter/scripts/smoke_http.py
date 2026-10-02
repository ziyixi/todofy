"""Run the service on loopback with ephemeral tokens and fake providers.

No existing .env/auth is read. No external service is contacted. All artifacts
are disposable and live below a fresh TemporaryDirectory, never the real DB.
"""

from collections.abc import Callable
import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any
import urllib.error as error
import urllib.request as urllib_request


def main() -> None:
    """Exercise four HTTP operations with offline providers and fake mail."""
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    with tempfile.TemporaryDirectory(
        prefix="newsletter-http-smoke-"
    ) as temporary:
        env = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "TMPDIR", "LANG")
            if key in os.environ
        }
        tokens = {
            role: secrets.token_urlsafe(32) for role in ("EDITOR", "SEND")
        }
        env.update(
            {
                f"NEWSLETTER_{role}_TOKEN": token
                for role, token in tokens.items()
            }
        )
        env.update(
            NEWSLETTER_MODE="mock",
            NEWSLETTER_EDITOR="mock",
            NEWSLETTER_MAIL="fake",
            NEWSLETTER_NOTION="fake",
            NEWSLETTER_TODOFY="fake",
            NEWSLETTER_DATA_DIR=str(pathlib.Path(temporary) / "data"),
        )
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "newsletter.cli",
                "serve",
                "--port",
                str(port),
            ],
            env=env,
            cwd=temporary,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        client = urllib_request.build_opener(urllib_request.ProxyHandler({}))

        def request(
            path: str, data: dict[str, Any] | None = None, role: str = "EDITOR"
        ) -> dict[str, Any]:
            encoded = json.dumps(data).encode() if data is not None else None
            req = urllib_request.Request(
                f"http://127.0.0.1:{port}{path}",
                data=encoded,
                headers={
                    "Authorization": "Bearer " + tokens[role],
                    "Content-Type": "application/json",
                },
            )
            with client.open(req, timeout=3) as response:
                value: object = json.load(response)
                if not isinstance(value, dict):
                    raise ValueError("Expected a ProtoJSON object")
                return value

        def poll(
            fn: Callable[[], dict[str, Any]],
            predicate: Callable[[dict[str, Any]], bool],
        ) -> dict[str, Any]:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Smoke service exited early")
                try:
                    value = fn()
                    if predicate(value):
                        return value
                except (error.URLError, TimeoutError):
                    pass
                time.sleep(0.05)
            raise TimeoutError("Loopback smoke did not complete")

        try:
            poll(
                lambda: request("/healthz"),
                lambda value: value["status"] == "ok",
            )
            run = request(
                "/v1/runs",
                {
                    "request_key": "smoke-run",
                    "issue_date": "2026-09-05",
                },
            )
            completed = poll(
                lambda: request("/v1/runs/" + run["id"]),
                lambda value: value["state"] in {"ready", "failed", "blocked"},
            )
            assert completed["state"] == "ready", completed.get("error_code")
            path = "/v1/editions/" + completed["edition_id"]
            ready = poll(
                lambda: request(path),
                lambda value: (
                    value["state"] != "queued" and value["state"] != "running"
                ),
            )
            assert ready["state"] == "ready", ready.get("error_code")
            assert ready["personal_digest"]["is_fixture"]
            assert len(ready["personal_digest"]["items"]) == 3
            assert "研究讨论时间待确认" in ready["rendered"]["html"]
            preview_request = urllib_request.Request(
                f"http://127.0.0.1:{port}{path}/preview",
                headers={"Authorization": "Bearer " + tokens["EDITOR"]},
            )
            with client.open(preview_request, timeout=3) as preview:
                assert preview.headers["Cache-Control"] == "no-store"
                assert "sandbox" in preview.headers["Content-Security-Policy"]
                html = preview.read().decode("utf-8")
            expected = ready["rendered"]["html"].replace(
                'src="cid:newsletter-chart"',
                'src="data:image/png;base64,'
                + ready["rendered"]["chart_png"]
                + '"',
            )
            assert html == expected
            assert request(path)["rendered"] == ready["rendered"]
            approval = {
                "id": ready["id"],
                "request_key": "smoke-send",
                "expected_render_hash": ready["rendered"]["render_hash"],
            }
            assert (
                request(path + "/send", approval, "SEND")["delivery_state"]
                == "simulated"
            )
            assert (
                request(path + "/send", approval, "SEND")["delivery_state"]
                == "simulated"
            )
            assert (
                len(
                    list(
                        (pathlib.Path(temporary) / "data" / "outbox").glob(
                            "*.eml"
                        )
                    )
                )
                == 1
            )
            print(
                "HTTP smoke passed: run → frozen edition → simulated mail "
                "(one attempt, no external providers)."
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


if __name__ == "__main__":
    main()
