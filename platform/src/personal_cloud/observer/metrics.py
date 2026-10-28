"""Bounded node readings: kernel counters, statvfs and the Kubernetes metrics API.

Only numbers leave this module. Interface names, mount paths, Pod names and file contents never do.
Cumulative counters are sent raw; Fleet derives rates from two reports of the same boot.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from kubernetes import client as sdk
from kubernetes.client.exceptions import ApiException
from urllib3.exceptions import HTTPError

from ..deployment.kubernetes import Client

# Kernel-wide files are the host's inside any Pod; /proc/net/dev is not (it follows the Pod's network
# namespace), so the host's view comes from PID 1's file, mounted read-only at HOST_NET_DEV.
PROC = Path("/proc")
HOST_MEMINFO = Path("/host-meminfo")
HOST_NET_DEV = Path("/host-net-dev")
# statvfs only; nothing below these mounts is listed or read.
FILESYSTEMS = {
    "root": Path("/host-fs/root"),
    "k3s": Path("/host-fs/k3s"),
    "state": Path("/var/lib/observer"),
}
MAX_FILE_BYTES = 65_536
MAX_SAFE = 2**53 - 1
MAX_WORKLOADS = 16
BOOT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PHYSICAL = re.compile(r"(?:en|eth|wl|ww)[a-z0-9]{0,13}")
WORKLOAD_KEY = re.compile(r"[a-z][a-z0-9_-]{0,31}")
CPU_QUANTITY = re.compile(r"([0-9]{1,15})(n|u|m|)")
MEMORY_QUANTITY = re.compile(r"([0-9]{1,18})(Ki|Mi|Gi|Ti|k|M|G|T|)")
CPU_SCALE = {"n": 1e-9, "u": 1e-6, "m": 1e-3, "": 1.0}
MEMORY_SCALE = {
    "": 1,
    "k": 10**3,
    "M": 10**6,
    "G": 10**9,
    "T": 10**12,
    "Ki": 2**10,
    "Mi": 2**20,
    "Gi": 2**30,
    "Ti": 2**40,
}


def _read(path: Path, *, prefix: bool = False) -> str | None:
    """At most MAX_FILE_BYTES; a longer file is refused unless only its prefix is needed."""
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
    except OSError:
        return None
    if len(data) > MAX_FILE_BYTES:
        if not prefix:
            return None
        data = data[:MAX_FILE_BYTES]
    return data.decode("ascii", "replace")


def _safe(*values: float) -> bool:
    return all(0 <= value <= MAX_SAFE for value in values)


def cpu_times(text: str | None, ticks_per_second: int) -> dict[str, float] | None:
    """The aggregate `cpu` line of /proc/stat; the per-CPU lines only count CPUs."""
    if text is None or ticks_per_second <= 0:
        return None
    lines = text.split("\n")
    total = None
    count = 0
    for index, line in enumerate(lines):
        if not line.startswith("cpu"):
            # The CPU block must end inside the bounded prefix, or its count is unknown.
            if index == 0 or total is None or not line:
                return None
            break
        fields = line.split()
        if fields[0] == "cpu":
            if len(fields) < 9 or not all(item.isdigit() for item in fields[1:9]):
                return None
            # user nice system idle iowait irq softirq steal; guest time is already in user.
            total = [int(item) for item in fields[1:9]]
        elif re.fullmatch(r"cpu[0-9]{1,4}", fields[0]):
            count += 1
    else:
        return None
    if total is None or not 1 <= count <= 4096:
        return None

    def milliseconds(ticks: int) -> int:
        return ticks * 1000 // ticks_per_second

    value = {
        "cpu_count": count,
        "total_milliseconds": milliseconds(sum(total)),
        "idle_milliseconds": milliseconds(total[3]),
        "iowait_milliseconds": milliseconds(total[4]),
    }
    return value if _safe(value["total_milliseconds"]) else None


def load_average(text: str | None) -> dict[str, float] | None:
    try:
        one, five, fifteen = (float(item) for item in (text or "").split()[:3])
    except ValueError:
        return None
    if not all(0 <= item <= 1_000_000 for item in (one, five, fifteen)):
        return None
    return {"one_minute": one, "five_minutes": five, "fifteen_minutes": fifteen}


def memory(text: str | None) -> dict[str, float] | None:
    fields: dict[str, int] = {}
    for line in (text or "").splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if len(parts) == 2 and parts[1] == "kB" and parts[0].isdigit():
            fields[name] = int(parts[0]) * 1024
    try:
        value = {
            "total_bytes": fields["MemTotal"],
            "available_bytes": fields["MemAvailable"],
            "swap_total_bytes": fields["SwapTotal"],
            "swap_free_bytes": fields["SwapFree"],
        }
    except KeyError:
        return None
    if (
        not _safe(*value.values())
        or value["total_bytes"] < 1
        or value["available_bytes"] > value["total_bytes"]
        or value["swap_free_bytes"] > value["swap_total_bytes"]
    ):
        return None
    return value


def filesystem(path: Path) -> dict[str, float] | None:
    try:
        stats = os.statvfs(path)
    except OSError:
        return None
    size = stats.f_blocks * stats.f_frsize
    used = (stats.f_blocks - stats.f_bfree) * stats.f_frsize
    available = stats.f_bavail * stats.f_frsize
    if size < 1 or not _safe(size, used, available) or used + available > size:
        return None
    return {"size_bytes": size, "used_bytes": used, "available_bytes": available}


def network(text: str | None) -> dict[str, float] | None:
    """Sum of the physical interfaces in /proc/<pid>/net/dev; bridges, veths and tunnels are excluded."""
    if text is None:
        return None
    lines = text.splitlines()
    if len(lines) < 2 or len(lines) > 514 or "|" not in lines[0]:
        return None
    count = received = transmitted = 0
    for line in lines[2:]:
        name, separator, rest = line.partition(":")
        fields = rest.split()
        if not separator or len(fields) != 16 or not all(f.isdigit() for f in fields):
            return None
        if PHYSICAL.fullmatch(name.strip()):
            count += 1
            received += int(fields[0])
            transmitted += int(fields[8])
    if count > 64 or not _safe(received, transmitted):
        return None
    return {
        "interface_count": count,
        "receive_bytes": received,
        "transmit_bytes": transmitted,
    }


def cpu_cores(quantity: object) -> float | None:
    match = CPU_QUANTITY.fullmatch(quantity) if isinstance(quantity, str) else None
    return int(match[1]) * CPU_SCALE[match[2]] if match else None


def memory_bytes(quantity: object) -> int | None:
    match = MEMORY_QUANTITY.fullmatch(quantity) if isinstance(quantity, str) else None
    return int(match[1]) * MEMORY_SCALE[match[2]] if match else None


def workload_key(labels: object) -> str | None:
    """A Deployment's `app` label, or a CronJob's name from its Job; never the Pod's own name."""
    if not isinstance(labels, dict):
        return None
    key = labels.get("app")
    if key is None:
        job = labels.get("batch.kubernetes.io/job-name")
        key = re.sub(r"-[0-9]{1,12}$", "", job) if isinstance(job, str) else None
    return key if isinstance(key, str) and WORKLOAD_KEY.fullmatch(key) else None


def workload_usage(value: object) -> list[dict[str, object]]:
    """Sum a metrics.k8s.io PodMetricsList by workload; one malformed item discards the reading."""
    items = value.get("items") if isinstance(value, dict) else None
    if not isinstance(items, list) or len(items) > 64:
        return []
    usage: dict[str, list[float]] = {}
    for item in items:
        metadata = item.get("metadata") if isinstance(item, dict) else None
        containers = item.get("containers") if isinstance(item, dict) else None
        if not isinstance(metadata, dict) or not isinstance(containers, list):
            return []
        key = workload_key(metadata.get("labels"))
        if key is None:
            continue
        if len(containers) > 16:
            return []
        total = usage.setdefault(key, [0.0, 0])
        for container in containers:
            current = container.get("usage") if isinstance(container, dict) else None
            if not isinstance(current, dict):
                return []
            cores = cpu_cores(current.get("cpu"))
            size = memory_bytes(current.get("memory"))
            if cores is None or size is None:
                return []
            total[0] += cores
            total[1] += size
    # The largest by memory when more workloads run than a report may carry, then by key.
    kept = sorted(usage.items(), key=lambda entry: -entry[1][1])[:MAX_WORKLOADS]
    result = []
    for key, (cores, size) in sorted(kept):
        if cores > 4096 or not _safe(size):
            return []
        result.append(
            {"workload_key": key, "cpu_cores": round(cores, 4), "memory_bytes": size}
        )
    return result


class MetricsClient(Client):
    """The deployment client's identity and TLS settings, reading only pod metrics of its namespace."""

    def pod_metrics(self, *, timeout: float = 8) -> object:
        try:
            with self.lock:
                if self._api is None:
                    self._api = sdk.ApiClient(self._configuration())
                return self._api.call_api(
                    "/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods",
                    "GET",
                    path_params={"namespace": self.namespace},
                    query_params=[("limit", 64)],
                    header_params={"Accept": "application/json"},
                    response_types_map={200: "object"},
                    auth_settings=["BearerToken"],
                    _return_http_data_only=True,
                    _request_timeout=(3, timeout),
                )
        except (ApiException, HTTPError, OSError, ValueError, TypeError):
            return None


def workloads(namespace: str) -> list[dict[str, object]]:
    """Empty without metrics-server or without the namespaced `pods.metrics.k8s.io` list grant."""
    metrics = MetricsClient(
        namespace,
        token_file="/var/run/secrets/kubernetes.io/serviceaccount/token",
        ca_file="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    )
    try:
        return workload_usage(metrics.pod_metrics())
    finally:
        metrics.close()


def node_metrics(namespace: str) -> dict[str, object] | None:
    """None when even the boot identity is unreadable; any other unreadable group is left out."""
    boot = (_read(PROC / "sys/kernel/random/boot_id") or "").strip()
    try:
        uptime = float((_read(PROC / "uptime") or "").split()[0])
    except (IndexError, ValueError):
        return None
    if not BOOT_ID.fullmatch(boot) or not 0 <= uptime <= MAX_SAFE:
        return None
    value: dict[str, object] = {"boot_id": boot, "uptime_seconds": uptime}
    groups = {
        "cpu": cpu_times(_read(PROC / "stat", prefix=True), os.sysconf("SC_CLK_TCK")),
        "load": load_average(_read(PROC / "loadavg")),
        "memory": memory(_read(HOST_MEMINFO)),
        "network": network(_read(HOST_NET_DEV)),
    }
    value.update({name: group for name, group in groups.items() if group is not None})
    filesystems = {
        role: usage
        for role, path in FILESYSTEMS.items()
        if (usage := filesystem(path)) is not None
    }
    if filesystems:
        value["filesystems"] = filesystems
    usage = workloads(namespace)
    if usage:
        value["workloads"] = usage
    return value
