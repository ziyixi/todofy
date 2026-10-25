"""Gateway health supplies immutable source and deployment request identity only."""

from personal_cloud.status_daemon.adapters import codex_gateway


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
