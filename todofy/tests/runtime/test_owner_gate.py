"""The owner gate's configuration switches: MAINTENANCE_MODE and a missing CSRF_SIGNING_KEY.

Both only block writes; every read keeps working. The blocked POSTs carry no
body because the Worker answers before reading one (docs/dev-notes.md §3).
"""

from collections.abc import Iterator

import pytest

from tests.runtime.harness import Worker, start_gateway
from tests.runtime.owner_support import (
    CSRF_KEY,
    assert_private,
    assert_status,
    csrf_headers,
    issue_csrf,
    mint_csrf,
)

RECONCILE = "/api/v1/mailEvents/f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001:reconcile"


@pytest.fixture(scope="module")
def maintenance_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    yield from start_gateway(
        tmp_path_factory.mktemp("owner-maintenance-worker"),
        {"CSRF_SIGNING_KEY": CSRF_KEY, "MAINTENANCE_MODE": "true"},
    )


@pytest.fixture(scope="module")
def unconfigured_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    yield from start_gateway(tmp_path_factory.mktemp("owner-no-csrf-key-worker"), {})


def test_maintenance_blocks_writes_after_the_csrf_check(maintenance_worker: Worker) -> None:
    headers = issue_csrf(maintenance_worker.owner)
    for path in (RECONCILE, "/api/v1/latestReports:recompute"):
        response = maintenance_worker.owner.post(path, headers=headers)
        assert response.status_code == 503, path
        assert_status(response, 503, "MAINTENANCE")
        assert response.headers["retry-after"] == "300"
        assert_private(response)

    forged = maintenance_worker.owner.post(RECONCILE, headers=headers | {"origin": "https://evil.example"})
    assert_status(forged, 403, "CSRF_FAILED")


def test_maintenance_keeps_reads(maintenance_worker: Worker) -> None:
    for path in ("/api/v1/integration", "/api/v1/mailEvents", "/api/csrf", "/api/v1/serviceStatus"):
        assert maintenance_worker.owner.get(path).status_code == 200, path


@pytest.mark.reaches("NOT_CONFIGURED")
def test_missing_signing_key_blocks_only_csrf_and_writes(unconfigured_worker: Worker) -> None:
    issued = unconfigured_worker.owner.get("/api/csrf")
    assert_status(issued, 503, "NOT_CONFIGURED")
    assert_private(issued)

    write = unconfigured_worker.owner.post(RECONCILE, headers=csrf_headers(mint_csrf()))
    assert_status(write, 503, "NOT_CONFIGURED")

    assert unconfigured_worker.owner.get("/api/v1/integration").status_code == 200
    assert unconfigured_worker.owner.get("/api/v1/mailEvents").status_code == 200
