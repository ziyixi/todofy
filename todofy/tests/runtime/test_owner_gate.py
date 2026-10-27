"""Keyless owner-write checks precede maintenance and body validation; reads remain available.

Maintenance probes declare JSON but carry no body, since the gate answers before reading it.
"""

import uuid
from collections.abc import Iterator

import pytest
from ziyixi_proto.todofy.ui.v1 import todofy_ui_service_pb as pb

from tests.fakes.model_router_fake import ModelRouterFake
from tests.fakes.server import Reply
from tests.runtime.harness import Worker, start_gateway
from tests.runtime.owner_support import (
    ORIGIN,
    assert_message,
    assert_private,
    assert_status,
    issue_csrf,
)

RECONCILE = "/api/v1/mailEvents/f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001:reconcile"


@pytest.fixture(scope="module")
def maintenance_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    yield from start_gateway(
        tmp_path_factory.mktemp("owner-maintenance-worker"),
        {"MAINTENANCE_MODE": "true"},
    )


@pytest.fixture(scope="module")
def keyless_worker(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Worker]:
    yield from start_gateway(tmp_path_factory.mktemp("owner-no-csrf-key-worker"), {})


def test_maintenance_blocks_writes_after_the_csrf_check(maintenance_worker: Worker) -> None:
    headers = issue_csrf(maintenance_worker.owner) | {"content-type": "application/json"}
    for path in (RECONCILE, "/api/v1/latestReports:recompute"):
        response = maintenance_worker.owner.post(path, headers=headers)
        assert response.status_code == 503, path
        assert_status(response, 503, "MAINTENANCE")
        assert response.headers["retry-after"] == "300"
        assert_private(response)

    missing_header = maintenance_worker.owner.post(
        RECONCILE,
        headers={name: value for name, value in headers.items() if name != "x-csrf-token"},
    )
    assert_status(missing_header, 403, "CSRF_FAILED")
    forged = maintenance_worker.owner.post(RECONCILE, headers=headers | {"origin": "https://evil.example"})
    assert_status(forged, 403, "CSRF_FAILED")


def test_maintenance_keeps_reads(maintenance_worker: Worker) -> None:
    for path in ("/api/v1/integration", "/api/v1/mailEvents", "/api/csrf", "/api/v1/serviceStatus"):
        assert maintenance_worker.owner.get(path).status_code == 200, path


@pytest.mark.reaches("NOT_CONFIGURED")
def test_model_catalog_authorization_failure_reports_not_configured(
    worker: Worker, fresh_gemini: ModelRouterFake
) -> None:
    fresh_gemini.queue(
        "GET",
        "/api/model/v1/models",
        Reply(403, {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "Synthetic"}}),
    )
    response = worker.owner.get("/api/v1/modelSettings")
    assert_status(response, 503, "NOT_CONFIGURED")
    assert_private(response)
    assert len(fresh_gemini.received("GET", "/api/model/v1/models")) == 1
    assert fresh_gemini.calls() == []


def test_owner_writes_work_without_a_signing_key(keyless_worker: Worker) -> None:
    issued = keyless_worker.owner.get("/api/csrf")
    assert issued.status_code == 200
    assert issued.json() == {"token": "1"}
    assert "set-cookie" not in issued.headers
    assert_private(issued)

    write = keyless_worker.owner.post(
        "/api/v1/latestReports:recompute",
        headers={"origin": ORIGIN, "x-csrf-token": "1"},
        json={"kind": "summary", "request_id": str(uuid.uuid4())},
    )
    assert assert_message(write, pb.RecomputeReportResponse)["summary"]["status"] == "empty_window"
    assert_private(write)

    assert keyless_worker.owner.get("/api/v1/integration").status_code == 200
    assert keyless_worker.owner.get("/api/v1/mailEvents").status_code == 200
