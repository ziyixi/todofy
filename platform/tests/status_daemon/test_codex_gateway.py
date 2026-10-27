"""Gateway health supplies build identity and process liveness only."""

from datetime import UTC, datetime

from personal_cloud.status_daemon.adapters import codex_gateway
from personal_cloud.status_daemon.config import Workload
from personal_cloud.status_daemon.evidence import workload
from ziyixi_proto.wire_json import to_wire


def test_gateway_identity_is_independent_of_configmap_claims():
    value = codex_gateway(
        {
            "service": "codex-gateway",
            "status": "ok",
            "source_sha": "a" * 40,
            "release_request_id": "e72013ab-1338-4928-8cec-d853ed778167",
        }
    )
    assert value.health == "healthy"
    assert value.admission == "unsupported"
    assert value.source_sha == "a" * 40
    assert value.request_id == "e72013ab-1338-4928-8cec-d853ed778167"


def test_gateway_health_without_valid_build_or_request_cannot_verify_a_release():
    value = codex_gateway(
        {
            "service": "codex-gateway",
            "status": "ok",
            "source_sha": "dev",
            "release_request_id": "pending",
        }
    )
    assert value.source_sha is None
    assert value.request_id is None


def test_gateway_failed_or_foreign_response_is_unknown():
    for response in (
        {},
        {"service": "newsletter", "status": "ok"},
        {"service": "codex-gateway", "status": "failed"},
    ):
        assert codex_gateway(response).health == "unknown"


def test_older_gateway_usage_fields_are_ignored_and_never_reported():
    business = codex_gateway(
        {
            "service": "codex-gateway",
            "status": "ok",
            "inference_status": {"request_count": 3, "active_count": 1},
        }
    )
    assert business.health == "healthy"
    assert business.active_count is None
    observed = workload(
        Workload(
            "codex-gateway",
            "codex-gateway",
            "codex-gateway",
            "codex-gateway-release",
            "codex-gateway",
        ),
        None,
        None,
        None,
        business,
        datetime(2026, 10, 25, 12, tzinfo=UTC),
    )
    assert "inference_status" not in to_wire(observed)
    assert "active_count" not in to_wire(observed)
