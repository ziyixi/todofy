"""Run offline tests by default; external integration needs an explicit run."""

from collections.abc import Iterator
import pathlib
import socket

import pytest

import newsletter.settings as newsletter_settings
import newsletter.store as newsletter_store


@pytest.fixture(autouse=True)
def no_external_network(monkeypatch):
    original_connect = socket.socket.connect

    def guarded_connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise AssertionError("Tests must not open an Internet connection")
        return original_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)


@pytest.fixture
def settings(tmp_path: pathlib.Path) -> newsletter_settings.Settings:
    """Provide default offline test settings."""
    return newsletter_settings.Settings(
        data_dir=tmp_path / "data",
        editor_token="e" * 32,
        send_token="s" * 32,
    )


@pytest.fixture
def store(tmp_path: pathlib.Path) -> Iterator[newsletter_store.Store]:
    """Provide a temporary SQLite store in mock mode."""
    database = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "mock")
    try:
        yield database
    finally:
        database.close()


pytest_plugins = (
    "tests.support.editor",
    "tests.support.story_pipeline",
    "tests.support.story_editor",
)
