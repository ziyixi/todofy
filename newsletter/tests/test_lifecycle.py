"""App factories are inert; each lifespan owns only its own resources."""

import asyncio
import dataclasses
import sqlite3

import fastapi.testclient as testclient
import pytest

import newsletter.app as newsletter_app
import newsletter.preflight as preflight
import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store
import newsletter.worker as newsletter_worker


@pytest.fixture
def settings(tmp_path):
    return newsletter_settings.Settings(
        data_dir=tmp_path / "first",
        editor_token="e" * 32,
        send_token="s" * 32,
    )


def test_factory_does_not_open_storage_or_start_dependencies(
    settings, monkeypatch
):
    def unexpected(*args, **kwargs):
        pytest.fail("Factory performed startup work")

    monkeypatch.setattr(newsletter_store, "Store", unexpected)
    monkeypatch.setattr(preflight, "preflight", unexpected)
    app = newsletter_app.create_app(settings)
    assert app.openapi()["info"]["title"] == "Personal Newsletter"
    assert not settings.data_dir.exists()


def test_two_apps_do_not_share_authentication_or_storage(settings):
    second = dataclasses.replace(
        settings,
        data_dir=settings.data_dir.with_name("second"),
        editor_token="b" * 32,
        send_token="c" * 32,
    )
    with (
        testclient.TestClient(newsletter_app.create_app(settings)) as first,
        testclient.TestClient(newsletter_app.create_app(second)) as other,
    ):
        for client, own, foreign in (
            (first, settings, second),
            (other, second, settings),
        ):
            assert (
                client.get(
                    "/v1/runs/00000000-0000-4000-8000-000000000000",
                    headers={"Authorization": "Bearer " + own.editor_token},
                ).status_code
                == 404
            )
            assert (
                client.get(
                    "/v1/runs/00000000-0000-4000-8000-000000000000",
                    headers={"Authorization": "Bearer " + foreign.editor_token},
                ).status_code
                == 401
            )
        assert first.app.state.store is not other.app.state.store
        assert first.app.state.worker is not other.app.state.worker


def test_data_directory_lock_is_exclusive_and_released(settings):
    with testclient.TestClient(newsletter_app.create_app(settings)) as first:
        with (
            pytest.raises(RuntimeError, match="data is busy"),
            testclient.TestClient(newsletter_app.create_app(settings)),
        ):
            pytest.fail("A second owner was allowed")
        assert first.get("/healthz").status_code == 200
    with testclient.TestClient(newsletter_app.create_app(settings)) as reopened:
        assert reopened.get("/healthz").status_code == 200


def test_preflight_failure_closes_storage_and_releases_lock(
    settings, monkeypatch
):
    original = preflight.preflight
    captured = []

    async def unavailable(settings, *, store):
        captured.append(store)
        raise preflight.PreflightError("CODEX_CHECK_FAILED")

    monkeypatch.setattr(preflight, "preflight", unavailable)
    with (
        pytest.raises(preflight.PreflightError),
        testclient.TestClient(newsletter_app.create_app(settings)),
    ):
        pytest.fail("Startup failure was ignored")
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        captured[0].db.execute("SELECT 1")
    monkeypatch.setattr(preflight, "preflight", original)
    with testclient.TestClient(newsletter_app.create_app(settings)) as reopened:
        assert reopened.get("/healthz").status_code == 200


def test_shutdown_stops_worker_before_closing_its_store(settings, monkeypatch):
    events = []
    original_close = newsletter_store.Store.close

    async def idle(worker):
        events.append("worker_started")
        try:
            await asyncio.Event().wait()
        finally:
            worker.store.db.execute("SELECT 1")
            events.append("worker_stopped")

    def close(store):
        events.append("store_closed")
        original_close(store)

    monkeypatch.setattr(newsletter_worker.Worker, "run", idle)
    monkeypatch.setattr(newsletter_store.Store, "close", close)
    with testclient.TestClient(newsletter_app.create_app(settings)) as client:
        assert client.get("/healthz").status_code == 200
        assert events == ["worker_started"]
    assert events == ["worker_started", "worker_stopped", "store_closed"]
