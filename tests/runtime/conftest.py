"""Fixtures for the black-box runtime tests; the machinery lives in harness.py."""

import hashlib
from collections.abc import Iterator

import pytest

from tests.fakes.server import FakeServer
from tests.runtime.harness import WEBHOOK_TOKEN, AccessIssuer, Worker, start_worker


@pytest.fixture(scope="session")
def gemini() -> Iterator[FakeServer]:
    server = FakeServer()
    yield server
    server.close()


@pytest.fixture
def fresh_gemini(gemini: FakeServer) -> FakeServer:
    gemini.reset()
    return gemini


@pytest.fixture(scope="session")
def worker(tmp_path_factory: pytest.TempPathFactory, gemini: FakeServer) -> Iterator[Worker]:
    yield from start_worker(
        "wrangler.test.toml",
        tmp_path_factory.mktemp("worker"),
        {
            "GEMINI_API_BASE": gemini.url,
            "GEMINI_API_KEY": "fake-gemini-key",
            "MAIL_WEBHOOK_TOKEN_SHA256": hashlib.sha256(WEBHOOK_TOKEN.encode()).hexdigest(),
        },
    )


@pytest.fixture
def throwaway_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    """For requests answered before their body is read: wrangler's local proxy then
    may drop the next POST on the same server (not a production behaviour)."""
    yield from start_worker(
        "wrangler.test.toml",
        tmp_path_factory.mktemp("throwaway-worker"),
        {
            "MAIL_WEBHOOK_TOKEN_SHA256": hashlib.sha256(WEBHOOK_TOKEN.encode()).hexdigest(),
        },
    )


@pytest.fixture(scope="session")
def access() -> Iterator[AccessIssuer]:
    issuer = AccessIssuer()
    yield issuer
    issuer.server.close()


@pytest.fixture(scope="session")
def auth_worker(tmp_path_factory: pytest.TempPathFactory, access: AccessIssuer) -> Iterator[Worker]:
    # No webhook digest on purpose: this instance also proves the 503 not_configured path.
    yield from start_worker(
        "wrangler.test-auth.toml",
        tmp_path_factory.mktemp("auth-worker"),
        {
            "ACCESS_ISSUER": access.url,
        },
    )
