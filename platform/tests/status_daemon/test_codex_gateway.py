"""Gateway health supplies build identity and bounded content-free inference observations."""

import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path

from personal_cloud.status_daemon.adapters import codex_gateway
from personal_cloud.status_daemon.config import Workload
from personal_cloud.status_daemon.evidence import workload
from ziyixi_proto.fleet.telemetry.v1.host_report_pb import HostReport
from ziyixi_proto.platform.runtime.v1.runtime_pb import NodeStatus
from ziyixi_proto.wire_json import from_wire, to_wire

INFERENCE = {
    "started_at": "2026-10-25T11:00:00Z",
    "observed_at": "2026-10-25T12:00:00Z",
    "model": "gpt-6.1-sol",
    "effort": "medium",
    "sdk_version": "0.163.0",
    "request_count": 3,
    "success_count": 1,
    "failure_count": 1,
    "active_count": 1,
    "input_tokens": 101,
    "output_tokens": 23,
    "usage_reported_count": 1,
    "last_completed_at": "2026-10-25T11:59:00Z",
    "last_duration_ms": 500,
    "average_duration_ms": 750,
    "last_error_code": "codex_quota",
    "recent_requests": [
        {
            "sequence": 2,
            "completed_at": "2026-10-25T11:59:00Z",
            "model": "gpt-6.1-sol",
            "effort": "medium",
            "duration_ms": 500,
            "error_code": "codex_quota",
            "input_tokens": 0,
            "output_tokens": 0,
            "usage_available": False,
        }
    ],
}


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


def test_gateway_monitoring_passes_through_the_existing_runtime_contract():
    business = codex_gateway(
        {"service": "codex-gateway", "status": "ok", "inference_status": INFERENCE}
    )
    assert business.health == "healthy"
    assert business.active_count == 1
    assert to_wire(business.inference_status) == INFERENCE
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
    assert to_wire(observed)["inference_status"] == INFERENCE


def test_invalid_or_legacy_monitoring_does_not_invent_counters_or_hide_process_health():
    for invalid in (
        None,
        {**INFERENCE, "input_json": "Private synthetic input"},
        {**INFERENCE, "request_count": True},
        {**INFERENCE, "recent_requests": INFERENCE["recent_requests"] * 9},
    ):
        business = codex_gateway(
            {"service": "codex-gateway", "status": "ok", "inference_status": invalid}
        )
        assert business.health == "healthy"
        assert business.inference_status is None
        assert business.active_count is None
    legacy = codex_gateway({"service": "codex-gateway", "status": "ok"})
    assert legacy.inference_status is None
    assert legacy.active_count is None


def test_nested_samples_reject_unsafe_metadata():
    for key, text in (
        ("model", "Private synthetic model/path"),
        ("error_code", "Private synthetic provider exception"),
    ):
        invalid = deepcopy(INFERENCE)
        invalid["recent_requests"][0][key] = text
        business = codex_gateway(
            {"service": "codex-gateway", "status": "ok", "inference_status": invalid}
        )
        assert business.inference_status is None


def test_daily_history_and_samples_fit_the_existing_node_and_fleet_report_budgets():
    source = (
        Path(__file__).resolve().parents[3]
        / "contracts/fleet-report-v1/fixtures/healthy.json"
    )
    report = json.loads(source.read_text())
    gateway = deepcopy(report["runtime"]["workloads"][0])
    key = "codex-gateway"
    gateway.update(name="workloads/" + key, workload_key=key)
    for target in ("desired", "actual"):
        gateway["release"][target]["workload_key"] = key
    inference = deepcopy(INFERENCE)
    inference["recent_requests"] = [
        {**inference["recent_requests"][0], "sequence": i, "model": "m" * 64}
        for i in range(8, 0, -1)
    ]
    inference["history_since"] = "2026-09-25T12:00:00Z"
    inference["daily_usage"] = [
        {
            "day": (datetime(2026, 10, 25, tzinfo=UTC) - timedelta(days=i))
            .date()
            .isoformat(),
            "request_count": 100,
            "success_count": 90,
            "failure_count": 10,
            "usage_reported_count": 95,
            "input_tokens": 1_000_000,
            "output_tokens": 10_000,
            "total_duration_ms": 500_000,
        }
        for i in range(30)
    ]
    gateway["inference_status"] = inference
    report["runtime"]["workloads"].insert(0, gateway)
    node = from_wire(NodeStatus, report["runtime"], strict=True).message
    host = from_wire(HostReport, report, strict=True).message
    assert len(json.dumps(to_wire(node), separators=(",", ":")).encode()) < 12_288
    assert len(json.dumps(to_wire(host), separators=(",", ":")).encode()) < 16_384
