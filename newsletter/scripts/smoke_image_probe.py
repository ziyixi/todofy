"""Container probe supplied over stdin, never baked into the service image."""

from collections.abc import Callable
import hashlib
import importlib.metadata as metadata
import importlib.resources as resources
import importlib.util as util
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Literal, overload, TypedDict
import urllib.error as error
import urllib.request as urllib_request

import newsletter.collection.instructions as instructions
import newsletter.console_access as console_access
import newsletter.contracts as contracts
import newsletter.preflight as preflight
import newsletter.rendering as rendering
import newsletter.types as types


class ProbeInput(TypedDict):
    """Audited hashes and credential-free startup code supplied by CI."""

    source_hashes: dict[str, str]
    startup_source: str
    console_audience: str | None


def check_package(expected: dict[str, str]) -> None:
    """Check isolation, installed resources and production-only dependencies."""
    assert os.getuid() == os.getgid() == 10001
    assert os.statvfs("/").f_flag & os.ST_RDONLY
    assert len(pathlib.Path("/proc/net/route").read_text().splitlines()) == 1
    for _, name in socket.if_nameindex():
        if name != "lo":
            assert (
                not int(
                    pathlib.Path("/sys/class/net", name, "flags").read_text(),
                    16,
                )
                & 1
            )
    package = resources.files("newsletter")
    assert "site-packages/newsletter" in str(package)
    assert not pathlib.Path("/opt/newsletter/src").exists()
    for relative, digest in expected.items():
        assert (
            hashlib.sha256(package.joinpath(relative).read_bytes()).hexdigest()
            == digest
        ), relative
    generated = package.joinpath("generated")
    assert not generated.is_file() and not generated.is_dir(), (
        "Unexpected generated package contents"
    )
    assert all(
        util.find_spec(name) is None
        for name in (
            "pytest",
            "ruff",
            "mypy",
            "build",
            "uv",
            "newsletter.generated",
        )
    )
    assert shutil.which("uv") is None
    preflight.check_proto_dependency()


def check_console_policy(audience: str | None) -> None:
    """The baked Access policy is the recorded console AUD, or absent."""
    verifier = console_access.load_policy()
    if audience is None:
        assert not console_access.POLICY_FILE.exists() and verifier is None
    else:
        assert verifier is not None and verifier.audience == audience


def check_console(port: int, token: str, configured: bool) -> None:
    """The console listener refuses every request without an Access login."""
    client = urllib_request.build_opener(urllib_request.ProxyHandler({}))
    expected = (401, "UNAUTHORIZED") if configured else (503, "NOT_CONFIGURED")
    base = f"http://127.0.0.1:{port}"
    for path, headers, answer in (
        ("/api/newsletter/v1/overview", {}, expected),
        # The engine's machine credential is no console credential.
        (
            "/api/newsletter/v1/overview",
            {"Authorization": "Bearer " + token},
            expected,
        ),
        # Nothing of the engine is served on the console's port.
        ("/v1/runs", {"Authorization": "Bearer " + token}, (404, "NOT_FOUND")),
    ):
        try:
            client.open(
                urllib_request.Request(base + path, headers=headers), timeout=3
            )
        except error.HTTPError as refused:
            body = json.load(refused)
            reason = body["error"]["details"][0]["reason"]
            assert (refused.code, reason) == answer, path
            assert refused.headers["Cache-Control"] == "no-store"
        else:
            raise AssertionError("The console answered without a login")


def check_http(root: pathlib.Path, *, console_configured: bool) -> None:
    """Exercise mock collection and preview over container-local loopback."""
    ports = []
    for _ in range(2):
        with socket.socket() as available:
            available.bind(("127.0.0.1", 0))
            ports.append(available.getsockname()[1])
    port, console = ports
    tokens = {role: secrets.token_urlsafe(32) for role in ("EDITOR", "SEND")}
    environment = {
        "PATH": os.defpath,
        "HOME": str(root),
        "TMPDIR": str(root),
        "LANG": "C.UTF-8",
        "NEWSLETTER_MODE": "mock",
        "NEWSLETTER_EDITOR": "mock",
        "NEWSLETTER_MAIL": "fake",
        "NEWSLETTER_ALLOW_SEND": "false",
        "NEWSLETTER_NOTION": "fake",
        "NEWSLETTER_TODOFY": "fake",
        "NEWSLETTER_DATA_DIR": str(root / "data"),
        "NEWSLETTER_CONSOLE_PORT": str(console),
        **{f"NEWSLETTER_{role}_TOKEN": value for role, value in tokens.items()},
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-I",
            "-m",
            "newsletter.cli",
            "serve",
            "--port",
            str(port),
        ],
        cwd=root,
        env=environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    client = urllib_request.build_opener(urllib_request.ProxyHandler({}))

    @overload
    def request(
        path: str,
        data: types.Payload | None = None,
        *,
        html: Literal[False] = False,
    ) -> types.Payload: ...

    @overload
    def request(
        path: str,
        data: types.Payload | None = None,
        *,
        html: Literal[True],
    ) -> str: ...

    def request(
        path: str, data: types.Payload | None = None, *, html: bool = False
    ) -> types.Payload | str:
        req = urllib_request.Request(
            f"http://127.0.0.1:{port}" + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={
                "Authorization": "Bearer " + tokens["EDITOR"],
                "Content-Type": "application/json",
            },
        )
        with client.open(req, timeout=3) as response:
            if html:
                assert response.status == 200
                assert response.headers["Cache-Control"] == "no-store"
                assert "sandbox" in response.headers["Content-Security-Policy"]
                raw: bytes = response.read()
                return raw.decode()
            value: object = json.load(response)
            assert isinstance(value, dict)
            return value

    def poll(
        path: str, predicate: Callable[[types.Payload], bool]
    ) -> types.Payload:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(
                    "Image smoke service exited before completion"
                )
            try:
                result = request(path)
                if predicate(result):
                    return result
            except (error.URLError, TimeoutError):
                pass
            time.sleep(0.05)
        raise TimeoutError("Image loopback HTTP smoke exceeded its deadline")

    try:
        poll("/healthz", lambda value: value["status"] == "ok")
        check_console(console, tokens["EDITOR"], console_configured)
        run = request(
            "/v1/runs",
            {"request_key": "image-smoke", "issue_date": "2026-09-05"},
        )
        run = poll(
            "/v1/runs/" + run["id"],
            lambda value: value["state"] in {"ready", "failed", "blocked"},
        )
        assert run["state"] == "ready", run.get("error_code")
        instruction_dir = pathlib.Path(
            str(resources.files("newsletter").joinpath("instructions"))
        )
        assert len(run["directions"]) == len(
            instructions.load_instructions(instruction_dir)
        )
        assert all(
            direction["state"] == "collected" for direction in run["directions"]
        )
        path = "/v1/editions/" + run["edition_id"]
        edition = request(path)
        assert edition["state"] == "ready" and edition["is_fixture"] is True
        assert (
            edition["delivery_state"] == "not_requested"
            and not edition["provider_message_id"]
        )
        rendered = edition["rendered"]
        assert rendered["render_hash"] == contracts.content_hash(
            {key: rendered[key] for key in ("html", "text", "chart_png")}
        )
        preview = request(path + "/preview", html=True)
        assert preview == rendering.preview_html(rendered)
        assert "MOCK" in preview and "TODOFY / 与你有关" in preview
        assert not list(root.rglob("*.eml"))
    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def main(payload: ProbeInput) -> None:
    """Verify the final image without credentials, email or external network."""
    check_package(payload["source_hashes"])
    check_console_policy(payload["console_audience"])
    with tempfile.TemporaryDirectory(
        prefix="newsletter-image-probe-"
    ) as temporary:
        root = pathlib.Path(temporary)
        startup = root / "startup.py"
        startup.write_text(payload["startup_source"])
        subprocess.run(
            [sys.executable, "-I", str(startup)],
            cwd=root,
            env={
                "PATH": os.defpath,
                "HOME": str(root),
                "TMPDIR": str(root),
                "LANG": "C.UTF-8",
            },
            check=True,
            timeout=40,
        )
        check_http(
            root, console_configured=payload["console_audience"] is not None
        )
        assert not list(root.rglob("auth.json")) and not list(
            root.rglob("*.eml")
        )
    print(
        json.dumps(
            {
                "source_files_exact": len(payload["source_hashes"]),
                "proto_version": metadata.version("ziyixi-protos"),
                "production_distributions": len(list(metadata.distributions())),
                "model_router_client_checks": 2,
                "mock_http": "ready/preview",
                "console": "refuses without login",
                "mail_files": 0,
                "external_network": False,
                "rootfs_read_only": True,
                "uid": os.getuid(),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main(json.load(sys.stdin))
