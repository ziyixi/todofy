"""Run offline tests by default; external integration needs an explicit run."""

import socket

import pytest


@pytest.fixture(autouse=True)
def no_external_network(monkeypatch):
    original_connect = socket.socket.connect

    def guarded_connect(sock, address):
        if sock.family in (socket.AF_INET, socket.AF_INET6):
            raise AssertionError("Tests must not open an Internet connection")
        return original_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)


pytest_plugins = (
    "tests.support.editor",
    "tests.support.story_pipeline",
    "tests.support.story_editor",
)
