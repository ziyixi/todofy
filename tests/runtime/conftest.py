"""Fixtures for the black-box runtime tests; the machinery lives in harness.py.

Each scenario module gets its own fakes and its own Worker (a fresh D1 and
Durable Object), because the object is one serial executor with global state:
a hanging upstream, a Todoist auth block or a spent token budget would
otherwise leak into the next module.
"""

from collections.abc import Callable, Iterator

import pytest

from tests.fakes.gemini_fake import API_KEY as GEMINI_KEY
from tests.fakes.gemini_fake import GeminiFake
from tests.fakes.todoist_fake import PROJECT_ID, TodoistFake
from tests.fakes.todoist_fake import TOKEN as TODOIST_TOKEN
from tests.runtime.harness import (
    CSRF_SIGNING_KEY,
    PREVIOUS_WEBHOOK_TOKEN,
    REPORT_PASSWORD,
    REPORT_USER,
    WEBHOOK_TOKEN,
    AccessIssuer,
    Worker,
    sha256_hex,
    start_worker,
)

Launch = Callable[..., Worker]


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "reaches(*codes): ledger codes and API errors a scenario drives the Worker to (coverage map)"
    )


def pipeline_vars(gemini: GeminiFake, todoist: TodoistFake) -> dict[str, str]:
    """Secrets and upstream URLs for a fully configured Worker (timings are in wrangler.test.toml)."""
    return {
        "GEMINI_API_BASE": gemini.url,
        "GEMINI_API_KEY": GEMINI_KEY,
        "TODOIST_API_BASE": todoist.url,
        "TODOIST_API_KEY": TODOIST_TOKEN,
        "TODOIST_DEFAULT_PROJECT_ID": PROJECT_ID,
        "MAIL_WEBHOOK_TOKEN_SHA256": sha256_hex(WEBHOOK_TOKEN),
        "MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS": sha256_hex(PREVIOUS_WEBHOOK_TOKEN),
        "REPORT_BASIC_AUTH_SHA256": sha256_hex(f"{REPORT_USER}:{REPORT_PASSWORD}"),
        "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY,
    }


@pytest.fixture(scope="module")
def gemini() -> Iterator[GeminiFake]:
    server = GeminiFake()
    yield server
    server.close()


@pytest.fixture(scope="module")
def todoist() -> Iterator[TodoistFake]:
    server = TodoistFake()
    yield server
    server.close()


@pytest.fixture(scope="module")
def launch(tmp_path_factory: pytest.TempPathFactory, gemini: GeminiFake, todoist: TodoistFake) -> Iterator[Launch]:
    """Start a Worker wired to this module's fakes; ``NAME=None`` drops a var, others override."""
    running: list[Iterator[Worker]] = []

    def start(config: str = "wrangler.test.toml", **overrides: str | None) -> Worker:
        variables = {
            name: value for name, value in (pipeline_vars(gemini, todoist) | overrides).items() if value is not None
        }
        process = start_worker(config, tmp_path_factory.mktemp("worker"), variables)
        running.append(process)
        return next(process)

    yield start
    for process in running:
        process.close()


@pytest.fixture(scope="module")
def worker(launch: Launch) -> Worker:
    return launch()


@pytest.fixture
def fresh_gemini(gemini: GeminiFake) -> GeminiFake:
    gemini.reset()
    return gemini


@pytest.fixture
def fresh_todoist(todoist: TodoistFake) -> TodoistFake:
    todoist.reset()
    return todoist


@pytest.fixture
def throwaway_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    """For requests answered before their body is read: wrangler's local proxy then
    may drop the next POST on the same server (not a production behaviour)."""
    yield from start_worker(
        "wrangler.test.toml",
        tmp_path_factory.mktemp("throwaway-worker"),
        {"MAIL_WEBHOOK_TOKEN_SHA256": sha256_hex(WEBHOOK_TOKEN)},
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
        {"ACCESS_ISSUER": access.url, "CSRF_SIGNING_KEY": CSRF_SIGNING_KEY},
    )
