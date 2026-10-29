"""The console listener lives inside the engine's lifespan, and never hurts it.

It starts after storage is open and recovered, stops before the store closes,
leaves the engine's signal handling alone, and a port it cannot bind is logged
while the engine keeps serving.
"""

import asyncio
import dataclasses
import signal
import socket
import sys

import fastapi
import fastapi.testclient as testclient
import httpx
import pytest

import newsletter.app as newsletter_app
import newsletter.cli as cli
import newsletter.console_access as console_access
import newsletter.lifecycle as lifecycle
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import tests.support.console_auth as auth


def _free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def settings(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        editor_token="e" * 32,
        send_token="s" * 32,
        console_port=_free_port(),
    )


@pytest.fixture
def loopback(monkeypatch):
    """Let this test reach its own listener; nothing else."""

    def connect(sock, address):
        assert address[0] == "127.0.0.1"
        return super(socket.socket, sock).connect(address)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(lifecycle, "CONSOLE_HOST", "127.0.0.1")
    monkeypatch.setattr(console_access, "load_policy", auth.verifier)


def test_the_port_off_starts_no_listener(settings, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("The console started with its port off")

    monkeypatch.setattr(lifecycle, "_start_console", unexpected)
    off = newsletter_settings.Settings(
        data_dir=settings.data_dir, editor_token="e" * 32, send_token="s" * 32
    )
    with testclient.TestClient(newsletter_app.create_app(off)) as client:
        assert client.get("/healthz").status_code == 200


def test_the_listener_answers_owner_reads_only(settings, loopback):
    base = f"http://127.0.0.1:{settings.console_port}/api/newsletter/v1/"
    with (
        testclient.TestClient(newsletter_app.create_app(settings)) as engine,
        httpx.Client(timeout=5) as client,
    ):
        assert engine.get("/healthz").status_code == 200
        owner = {"cf-access-jwt-assertion": auth.assertion()}
        answer = client.get(base + "overview", headers=owner)
        assert answer.status_code == 200
        assert answer.headers["content-type"] == "application/json"
        assert answer.json()["name"] == "overview"
        assert answer.headers["cache-control"] == "no-store"
        assert "server" not in answer.headers
        assert client.get(base + "overview").status_code == 401
        refused = client.post(base + "overview", headers=owner)
        assert refused.status_code == 405
        assert refused.json()["error"]["status"] == "UNIMPLEMENTED"
        # Nothing of the engine is served on the console's port.
        root = f"http://127.0.0.1:{settings.console_port}"
        for path in ("/healthz", "/v1/runs", "/internal/monitoring/status"):
            assert client.get(root + path, headers=owner).status_code == 404
        # And nothing of the console on the engine's.
        assert engine.get("/api/newsletter/v1/overview").status_code == 404


def test_a_port_it_cannot_bind_leaves_the_engine_serving(
    settings, loopback, caplog
):
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", settings.console_port))
        taken.listen()
        with testclient.TestClient(
            newsletter_app.create_app(settings)
        ) as engine:
            assert engine.get("/healthz").status_code == 200
    assert "console_listener_failed" in caplog.text


def test_it_starts_after_storage_and_stops_before_the_store(
    settings, loopback, monkeypatch
):
    events = []
    start, stop = lifecycle._start_console, lifecycle._stop_console
    close = newsletter_store.Store.close

    def started(*args, **kwargs):
        # Storage is open and recovered: the reader can answer already.
        events.append("console started")
        return start(*args, **kwargs)

    async def stopped(console):
        await stop(console)
        assert console is not None and console[1].done()
        events.append("console stopped")

    def closed(store):
        events.append("store closed")
        close(store)

    monkeypatch.setattr(lifecycle, "_start_console", started)
    monkeypatch.setattr(lifecycle, "_stop_console", stopped)
    monkeypatch.setattr(newsletter_store.Store, "close", closed)
    with testclient.TestClient(newsletter_app.create_app(settings)):
        events.append("serving")
    assert events == [
        "console started",
        "serving",
        "console stopped",
        "store closed",
    ]


def test_the_engines_signal_handlers_stay_its_own(settings, loopback):
    signals = (signal.SIGINT, signal.SIGTERM)

    async def run():
        # In the main thread uvicorn's own capture_signals would replace them.
        before = {sig: signal.getsignal(sig) for sig in signals}
        async with lifecycle.service_lifespan(
            fastapi.FastAPI(), settings=settings, start_worker=False
        ):
            # Give the console's server a turn to start serving.
            await asyncio.sleep(0.2)
            during = {sig: signal.getsignal(sig) for sig in signals}
        after = {sig: signal.getsignal(sig) for sig in signals}
        return before, during, after

    before, during, after = asyncio.run(run())
    assert before == during == after


@pytest.mark.parametrize("port", [1, 1023, 65536, -1])
def test_the_port_is_validated(settings, port):
    with pytest.raises(ValueError, match="NEWSLETTER_CONSOLE_PORT"):
        dataclasses.replace(settings, console_port=port).validate()
    dataclasses.replace(settings, console_port=0).validate()


@pytest.mark.parametrize("value", ["8080", " 08080"])
def test_the_console_cannot_take_the_engines_port(monkeypatch, capsys, value):
    def unexpected(*args, **kwargs):
        pytest.fail("The server started")

    monkeypatch.setattr(cli.uvicorn, "run", unexpected)
    monkeypatch.setenv("NEWSLETTER_CONSOLE_PORT", value)
    monkeypatch.setattr(sys, "argv", ["newsletter", "serve", "--port", "8080"])
    with pytest.raises(SystemExit):
        cli.main()
    assert "must differ" in capsys.readouterr().err
