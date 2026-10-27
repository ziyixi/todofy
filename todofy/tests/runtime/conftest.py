"""Fixtures for the black-box runtime tests; the machinery lives in harness.py.

Each scenario module gets its own fakes and its own Worker (a fresh D1, Durable
Object and Tasks D1), because the object is one serial executor with global state:
a hanging upstream or a spent token budget would otherwise leak into the next
module.
"""

from collections.abc import Callable, Iterator

import pytest

from tests.fakes.model_router_fake import ModelRouterFake
from tests.runtime.harness import (
    CSRF_SIGNING_KEY,
    GATEWAY_AUTH_CONFIG,
    GATEWAY_CONFIG,
    PREVIOUS_WEBHOOK_TOKEN,
    REPORT_PASSWORD,
    REPORT_USER,
    WEBHOOK_TOKEN,
    AccessIssuer,
    Worker,
    sha256_hex,
    start_gateway,
)

Launch = Callable[..., Worker]


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "reaches(*codes): ledger codes and API errors a scenario drives the Worker to (coverage map)"
    )
    # pytest-xdist may only hand out whole files (--dist loadfile): the rootdir conftest.py refuses the rest.


def pipeline_vars(gemini: ModelRouterFake) -> dict[str, str]:
    """Secrets and upstream URLs for a fully configured Worker (timings are in the core's wrangler.test.toml)."""
    return {
        "MODEL_ROUTER_FAKE_ORIGIN": gemini.url,
        "MAIL_WEBHOOK_TOKEN_SHA256": sha256_hex(WEBHOOK_TOKEN),
        "MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS": sha256_hex(PREVIOUS_WEBHOOK_TOKEN),
        "REPORT_BASIC_AUTH_SHA256": sha256_hex(f"{REPORT_USER}:{REPORT_PASSWORD}"),
        "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
    }


@pytest.fixture(scope="module")
def gemini() -> Iterator[ModelRouterFake]:
    server = ModelRouterFake()
    yield server
    server.close()


@pytest.fixture(scope="module")
def launch(tmp_path_factory: pytest.TempPathFactory, gemini: ModelRouterFake) -> Iterator[Launch]:
    """Start the gateway, core and Tasks wired to this module's fakes; ``NAME=None`` drops a var, others
    override."""
    running: list[Iterator[Worker]] = []

    def start(config: str = GATEWAY_CONFIG, **overrides: str | None) -> Worker:
        variables = {name: value for name, value in (pipeline_vars(gemini) | overrides).items() if value is not None}
        process = start_gateway(tmp_path_factory.mktemp("worker"), variables, config)
        running.append(process)
        return next(process)

    yield start
    for process in running:
        process.close()


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    return launch()


@pytest.fixture
def fresh_gemini(gemini: ModelRouterFake) -> ModelRouterFake:
    gemini.reset()
    return gemini


@pytest.fixture
def throwaway_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    """For requests answered before their body is read: wrangler's local proxy then
    may drop the next POST on the same server (not a production behaviour)."""
    yield from start_gateway(
        tmp_path_factory.mktemp("throwaway-worker"),
        {"MAIL_WEBHOOK_TOKEN_SHA256": sha256_hex(WEBHOOK_TOKEN), "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY},
    )


@pytest.fixture(scope="session")
def access() -> Iterator[AccessIssuer]:
    issuer = AccessIssuer()
    yield issuer
    issuer.server.close()


@pytest.fixture(scope="session")
def auth_worker(tmp_path_factory: pytest.TempPathFactory, access: AccessIssuer) -> Iterator[Worker]:
    # No webhook digest on purpose: this instance also proves the 503 not_configured path.
    yield from start_gateway(
        tmp_path_factory.mktemp("auth-worker"),
        {"ACCESS_ISSUER": access.url, "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY},
        GATEWAY_AUTH_CONFIG,
    )
