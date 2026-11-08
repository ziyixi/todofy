"""Bounded, labelled Deployment readiness, independent of releases and metrics-server."""

from __future__ import annotations

from kubernetes import client as sdk
from kubernetes.client.exceptions import ApiException
from urllib3.exceptions import HTTPError

from ..deployment.kubernetes import Client
from .metrics import (
    MAX_WORKLOADS,
    WORKLOAD_LABEL,
    current_pods,
    pod_aliases,
    workload_key,
)

MAX_OBJECTS = 64
MAX_COUNT = 2**31 - 1


class DiscoveryClient(Client):
    """Only two fixed all-namespace list reads, with the existing rotating identity and TLS."""

    def objects(self, *, timeout: float = 8) -> tuple[object, object]:
        try:
            with self.lock:
                if self._api is None:
                    self._api = sdk.ApiClient(self._configuration())
                return tuple(
                    self._api.call_api(
                        path,
                        "GET",
                        query_params=[
                            ("labelSelector", WORKLOAD_LABEL),
                            ("limit", MAX_OBJECTS),
                        ]
                        + (
                            [
                                (
                                    "fieldSelector",
                                    "status.phase!=Succeeded,status.phase!=Failed",
                                )
                            ]
                            if path == "/api/v1/pods"
                            else []
                        ),
                        header_params={"Accept": "application/json"},
                        response_types_map={200: "object"},
                        auth_settings=["BearerToken"],
                        _return_http_data_only=True,
                        _request_timeout=(3, timeout),
                    )
                    for path in ("/apis/apps/v1/deployments", "/api/v1/pods")
                )
        except (ApiException, HTTPError, OSError, ValueError, TypeError):
            return None, None


def _count(value: object) -> bool:
    return type(value) is int and 0 <= value <= MAX_COUNT


def _items(value: object, *, pods: bool = False) -> tuple[list | None, bool]:
    if not isinstance(value, dict) or not isinstance(value.get("items"), list):
        return None, False
    metadata = value.get("metadata", {})
    if not isinstance(metadata, dict):
        return None, False
    items = current_pods(value["items"]) if pods else value["items"]
    truncated = len(items) > MAX_OBJECTS or bool(metadata.get("continue"))
    return items[:MAX_OBJECTS], truncated


def _pod_status(pod: dict) -> tuple[str, int]:
    status = pod.get("status", {})
    phase = status.get("phase")
    containers = status.get("containerStatuses", [])
    init = status.get("initContainerStatuses", [])
    if not isinstance(containers, list) or not isinstance(init, list):
        raise TypeError("invalid_pod_status")
    restarts = sum(item.get("restartCount", 0) for item in containers + init)
    if not _count(restarts) or any(
        not _count(item.get("restartCount", 0)) for item in containers + init
    ):
        raise ValueError("invalid_pod_restarts")
    if phase == "Pending":
        return "starting", restarts
    if phase != "Running" or not containers:
        return "unknown", restarts
    conditions = status.get("conditions", [])
    ready = any(
        item.get("type") == "Ready" and item.get("status") == "True"
        for item in conditions
    ) and all(item.get("ready") is True for item in containers)
    return "ready" if ready else "degraded", restarts


def _observation(deployment: dict, pods: list[dict], key: str) -> dict[str, object]:
    row: dict[str, object] = {
        "workload_key": key,
        "state": "unknown",
        "readiness_probe": False,
    }
    try:
        if deployment.get("kind", "Deployment") != "Deployment":
            return row
        spec, status = deployment["spec"], deployment.get("status", {})
        containers = spec["template"]["spec"]["containers"]
        if not isinstance(containers, list) or not 1 <= len(containers) <= 16:
            return row
        row["readiness_probe"] = all(
            isinstance(container.get("readinessProbe"), dict)
            for container in containers
        )
        desired = spec.get("replicas", 1)
        ready = status.get("readyReplicas", 0)
        generation = deployment["metadata"].get("generation")
        observed = status.get("observedGeneration")
        if not all(_count(value) for value in (desired, ready)):
            return row
        row["desired_count"] = desired
        states = [_pod_status(pod) for pod in pods]
        ready_pods = sum(state == "ready" for state, _ in states)
        restarts = sum(restarts for _, restarts in states)
        if not _count(restarts):
            return row
        row.update(ready_count=ready_pods, restart_count=restarts)
        if not _count(generation) or not generation or not _count(observed):
            return row
        if observed > generation:
            return row
        failed = any(
            (
                condition.get("type") == "Progressing"
                and condition.get("status") == "False"
            )
            or (
                condition.get("type") == "ReplicaFailure"
                and condition.get("status") == "True"
            )
            for condition in status.get("conditions", [])
        )
        if desired > 0 and failed:
            row["state"] = "degraded"
        elif observed < generation:
            row["state"] = "starting"
        elif desired == 0:
            row["state"] = "stopped"
        elif any(state == "unknown" for state, _ in states):
            return row
        elif any(state == "degraded" for state, _ in states):
            row["state"] = "degraded"
        elif not states or any(state == "starting" for state, _ in states):
            row["state"] = "starting"
        elif ready >= desired and ready_pods >= desired:
            row["state"] = "ready"
        else:
            row["state"] = "degraded"
    except (AttributeError, KeyError, TypeError, ValueError):
        pass
    return row


def inventory(deployments: object, pods: object) -> tuple[dict[str, object], list]:
    """Public aliases and counts only; return selected Pods separately for the metrics join."""
    unavailable = {"state": "unavailable", "workloads": []}
    deployments, deployment_truncated = _items(deployments)
    pods, pod_truncated = _items(pods, pods=True)
    if deployments is None or pods is None:
        return unavailable, []
    # Partial lists cannot establish unique aliases or complete per-workload counts.
    if deployment_truncated or pod_truncated:
        return {"state": "truncated", "workloads": []}, []
    selected = pod_aliases(pods)
    if selected is None:
        return unavailable, []
    namespaces = {key: namespace for (namespace, _), key in selected.items()}
    declared = {}
    for deployment in deployments:
        metadata = deployment.get("metadata") if isinstance(deployment, dict) else None
        if not isinstance(metadata, dict):
            return unavailable, []
        key = workload_key(metadata.get("labels"))
        namespace = metadata.get("namespace")
        if (
            key is None
            or not isinstance(namespace, str)
            or not namespace
            or key in declared
        ):
            return unavailable, []
        if key in namespaces and namespaces[key] != namespace:
            return unavailable, []
        namespaces[key] = namespace
        declared[key] = deployment
    rows = [
        _observation(
            deployment,
            [
                pod
                for pod in pods
                if selected[pod["metadata"]["namespace"], pod["metadata"]["name"]]
                == key
            ],
            key,
        )
        for key, deployment in sorted(declared.items())
    ]
    return {
        "state": "truncated" if len(rows) > MAX_WORKLOADS else "observed",
        "workloads": rows[:MAX_WORKLOADS],
    }, pods


def discover(namespace: str) -> tuple[dict[str, object], list]:
    client = DiscoveryClient(namespace)
    try:
        return inventory(*client.objects())
    finally:
        client.close()
