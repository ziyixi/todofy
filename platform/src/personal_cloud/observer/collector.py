"""Content-free host observer. No SSH, models, mail, logs or remote commands."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import urllib.parse
import uuid
from pathlib import Path

from ziyixi_proto.fleet.telemetry.v1.host_report_pb import HostReport
from ziyixi_proto.platform.runtime.v1.runtime_pb import NodeStatus
from ziyixi_proto.wire_json import from_wire, to_wire

from ..deployment.kubernetes import Client, DependencyUnavailable
from .provenance import source_sha
from .systemd_snapshot import configured_daemons, legacy_daemons
from .systemd_snapshot import read as systemd_snapshot
from .transport import ObserverError, _request


def kube(env: dict[str, str]) -> dict[str, object]:
    unknown = {
        "state": "unknown",
        "ready_count": None,
        "desired_count": None,
        "restart_count": None,
    }
    namespace = env.get("FLEET_KUBE_NAMESPACE", "personal-cloud")
    if re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", namespace) is None:
        raise ObserverError("invalid_kube_namespace")
    try:
        client = Client(
            namespace,
            token_file="/var/run/secrets/kubernetes.io/serviceaccount/token",
            ca_file="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        )
        try:
            deploy = client.get("Deployment", "newsletter", timeout=8)
            nodes = client.nodes(timeout=8)
            pods = client.pods("newsletter", timeout=8)
        finally:
            client.close()
        status = deploy.get("status", {})
        spec = deploy.get("spec", {})
        ready = status.get("readyReplicas", 0)
        replicas = spec.get("replicas", 1)
        ready_nodes = bool(nodes.get("items")) and all(
            any(
                c.get("type") == "Ready" and c.get("status") == "True"
                for c in node.get("status", {}).get("conditions", [])
            )
            for node in nodes.get("items", [])
        )
        restarts = sum(
            c.get("restartCount", 0)
            for pod in pods.get("items", [])
            for c in pod.get("status", {}).get("containerStatuses", [])
        )
        return {
            "state": "ready" if ready_nodes and ready == replicas == 1 else "degraded",
            "ready_count": ready,
            "desired_count": replicas,
            "restart_count": restarts,
        }
    except (
        AttributeError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
        DependencyUnavailable,
    ):
        return {**unknown, "state": "unavailable"}


def runtime_status(env: dict[str, str]) -> dict[str, object] | None:
    """Read the shared bounded RuntimeService contract, never a provider body."""
    try:
        url = env.get(
            "FLEET_RUNTIME_URL", "http://platform-runtime:8080/api/v1/nodeStatus"
        )
        parsed_url = urllib.parse.urlsplit(url)
        if (
            parsed_url.scheme != "http"
            or re.fullmatch(
                r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", parsed_url.hostname or ""
            )
            is None
            or parsed_url.port != 8080
            or parsed_url.path != "/api/v1/nodeStatus"
            or parsed_url.username
            or parsed_url.password
            or parsed_url.query
            or parsed_url.fragment
        ):
            return None
        status, value = _request(url, limit=12_288)
        if status != 200:
            return None
        parsed = from_wire(NodeStatus, value, strict=True).message
        value = to_wire(parsed)
        if value["node_key"] != env.get("FLEET_HOST_KEY", "vps"):
            return None
        keys = [item["workload_key"] for item in value["workloads"]]
        if len(set(keys)) != len(keys) or keys != sorted(keys):
            return None
        now = dt.datetime.now(dt.timezone.utc)
        snapshots = [value["observed_at"]]
        for workload in value["workloads"]:
            key = workload["workload_key"]
            if workload["name"] != "workloads/" + key:
                return None
            for target in (
                workload["release"]["desired"],
                workload["release"]["actual"],
            ):
                if target and target["workload_key"] != key:
                    return None
            snapshots.extend(
                [workload["observed_at"], workload["release"]["observed_at"]]
            )
        for timestamp in snapshots:
            observed = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            age = (now - observed).total_seconds()
            if age < -120 or age > 60:
                return None
        return value
    except (ObserverError, KeyError, TypeError, ValueError):
        return None


def newsletter(env: dict[str, str]) -> dict[str, object]:
    unknown = {
        "state": "unavailable",
        "worker_healthy": None,
        "drain_state": "unknown",
        "queued_count": None,
        "inflight_count": None,
        "unknown_count": None,
    }
    token = env.get("NEWSLETTER_MONITOR_TOKEN", "")
    if not token:
        return unknown
    try:
        status, value = _request(
            "http://newsletter:8080/internal/monitoring/status",
            headers={"Authorization": f"Bearer {token}"},
            limit=4096,
        )
        keys = {
            "version",
            "worker_healthy",
            "drain_state",
            "queued_count",
            "inflight_count",
            "unknown_count",
            "build_source_sha",
            "release_request_id",
        }
        if (
            status != 200
            or not isinstance(value, dict)
            or set(value) != keys
            or type(value["version"]) is not int
            or value["version"] != 1
            or type(value["worker_healthy"]) is not bool
            or value["drain_state"] not in {"active", "draining", "frozen"}
            or any(
                type(value[name]) is not int or not 0 <= value[name] <= 2147483647
                for name in ("queued_count", "inflight_count", "unknown_count")
            )
        ):
            return unknown
        return {
            "state": "healthy" if value["worker_healthy"] else "unavailable",
            **{
                key: value[key]
                for key in (
                    "worker_healthy",
                    "drain_state",
                    "queued_count",
                    "inflight_count",
                    "unknown_count",
                )
            },
        }
    except ObserverError:
        return unknown


def resource_percentages() -> tuple[float | None, float | None]:
    disk = memory = None
    try:
        stats = os.statvfs("/var/lib/observer")
        disk = (
            round((1 - stats.f_bavail / stats.f_blocks) * 100, 1)
            if stats.f_blocks
            else None
        )
    except OSError:
        pass
    try:
        data = Path("/host-meminfo").read_text()
        if len(data) > 65_536:
            return disk, None
        fields = dict(line.split(":", 1) for line in data.splitlines() if ":" in line)
        total = int(fields["MemTotal"].split()[0])
        available = int(fields["MemAvailable"].split()[0])
        memory = round((1 - available / total) * 100, 1) if total else None
    except (KeyError, OSError, ValueError):
        pass
    return disk, memory


def observe(env: dict[str, str], sequence: int) -> bytes:
    cluster = kube(env)
    disk, memory = resource_percentages()
    daemons = systemd_snapshot()
    selected = {
        name: daemons[name]
        for name in configured_daemons(env)
        if name != "cloudflared_platform"
        or env.get("FLEET_EXPECT_PLATFORM_TUNNEL") == "true"
    }
    value = {
        "version": "fleet-report-v1",
        "host_key": env.get("FLEET_HOST_KEY", "vps"),
        "epoch": int(env.get("FLEET_HOST_EPOCH", "1")),
        "sequence": sequence,
        "receipt_id": str(uuid.uuid4()),
        "observation_time": dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "daemons": legacy_daemons(selected),
        "configured_daemons": selected,
        "cluster": cluster,
        "newsletter": newsletter(env),
        "disk_used_percent": disk,
        "memory_used_percent": memory,
        "runtime": runtime_status(env),
        "observer_source_sha": source_sha(),
    }
    for key in ("disk_used_percent", "memory_used_percent"):
        if value[key] is None:
            value.pop(key)
    for section in ("cluster", "newsletter"):
        value[section] = {
            key: item for key, item in value[section].items() if item is not None
        }
    message = from_wire(HostReport, value, strict=True).message
    data = json.dumps(
        to_wire(message), separators=(",", ":"), ensure_ascii=True
    ).encode()
    if len(data) > 16_384:
        raise ObserverError("report_too_large")
    return data
