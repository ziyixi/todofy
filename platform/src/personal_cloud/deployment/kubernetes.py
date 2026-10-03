"""Use the official Kubernetes SDK with a rotating, namespace-scoped pod identity."""

import re
import threading
from pathlib import Path

from kubernetes import client
from kubernetes.client.exceptions import ApiException
from urllib3.exceptions import HTTPError

RESOURCES = {
    "Deployment": ("/apis/apps/v1", "deployments"),
    "CronJob": ("/apis/batch/v1", "cronjobs"),
    "Service": ("/api/v1", "services"),
    "ConfigMap": ("/api/v1", "configmaps"),
    "Pod": ("/api/v1", "pods"),
    "Node": ("/api/v1", "nodes"),
}
DEFAULT_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token"
DEFAULT_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"


class DependencyUnavailable(RuntimeError):
    """A fixed safe error; the raw SDK response never crosses the API or logs."""

    def __init__(self, *, missing: bool = False):
        super().__init__("KUBERNETES_UNAVAILABLE")
        self.missing = missing


class Client:
    def __init__(
        self,
        namespace: str,
        *,
        token_file: str = DEFAULT_TOKEN,
        ca_file: str = DEFAULT_CA,
        origin: str = "https://kubernetes.default.svc",
    ):
        if origin not in {
            "https://kubernetes.default.svc",
            "https://127.0.0.1:6443",
            "https://localhost:6443",
        }:
            raise ValueError("invalid_trusted_cluster_origin")
        self.origin = origin
        self.namespace = namespace
        self.token_file = Path(token_file)
        self.ca_file = ca_file
        self.lock = threading.Lock()
        self._api = None

    def _configuration(self):
        config = client.Configuration()
        config.host = self.origin
        config.ssl_ca_cert = self.ca_file
        config.verify_ssl = True
        config.proxy = None
        config.retries = 0
        config.debug = False
        config.api_key_prefix["BearerToken"] = "Bearer"

        def refresh(configuration):
            token = self.token_file.read_text().strip()
            if not re.fullmatch(r"[A-Za-z0-9_.-]{24,16384}", token):
                raise ValueError("invalid_projected_identity")
            configuration.api_key["BearerToken"] = token

        config.refresh_api_key_hook = refresh
        refresh(config)
        return config

    def _call(
        self,
        kind: str,
        method: str,
        *,
        name: str | None = None,
        body: dict | None = None,
        content_type: str = "application/json",
        query: list | None = None,
        timeout: float = 10,
    ) -> dict:
        if kind in {"Pod", "Node"} and method != "GET":
            raise ValueError("invalid_runtime_resource")
        prefix, collection = RESOURCES[kind]
        if kind == "Node":
            path = prefix + "/" + collection
            parameters = {}
        else:
            path = prefix + "/namespaces/{namespace}/" + collection
            parameters = {"namespace": self.namespace}
        if name is not None:
            path += "/{name}"
            parameters["name"] = name
        try:
            with self.lock:
                if self._api is None:
                    self._api = client.ApiClient(self._configuration())
                # Generic SDK calls keep field casing, without discovery, a watch, or a parallel HTTP implementation.
                result = self._api.call_api(
                    path,
                    method,
                    path_params=parameters,
                    query_params=query or [],
                    header_params={
                        "Content-Type": content_type,
                        "Accept": "application/json",
                    },
                    body=body,
                    response_types_map={200: "object", 201: "object"},
                    auth_settings=["BearerToken"],
                    _return_http_data_only=True,
                    _request_timeout=(min(3, timeout), max(0.01, timeout)),
                )
            if not isinstance(result, dict):
                raise TypeError("invalid_kubernetes_response")
            return result
        except ApiException as error:
            raise DependencyUnavailable(missing=error.status == 404) from None
        except (HTTPError, OSError, ValueError, TypeError):
            raise DependencyUnavailable() from None

    def apply(self, resource: dict) -> None:
        if (
            resource["kind"] in {"Pod", "Node"}
            or resource["metadata"]["namespace"] != self.namespace
        ):
            raise ValueError("invalid_runtime_resource")
        self._call(
            resource["kind"],
            "PATCH",
            name=resource["metadata"]["name"],
            body=resource,
            query=[("fieldManager", "personal-cloud"), ("force", "false")],
            content_type="application/apply-patch+yaml",
        )

    def patch(self, kind: str, name: str, change: dict) -> None:
        # This manager owns only release control fields, separate from the baked manifests.
        # SSA also claims an unchanged value before the main manager relinquishes it.
        if kind == "ConfigMap":
            valid = change in (
                {"data": {"phase": "applying"}},
                {"data": {"phase": "activated"}},
            )
            api_version = "v1"
        elif kind == "CronJob":
            valid = (
                name == "newsletter-daily"
                and isinstance(change, dict)
                and set(change) == {"spec"}
                and isinstance(change["spec"], dict)
                and set(change["spec"]) == {"suspend"}
                and type(change["spec"]["suspend"]) is bool
            )
            api_version = "batch/v1"
        else:
            valid = False
        if not valid:
            raise ValueError("invalid_runtime_status")
        self._call(
            kind,
            "PATCH",
            name=name,
            body={
                "apiVersion": api_version,
                "kind": kind,
                "metadata": {"namespace": self.namespace, "name": name},
                **change,
            },
            query=[
                ("fieldManager", "personal-cloud-runtime-status"),
                ("force", "true"),
            ],
            content_type="application/apply-patch+yaml",
        )

    def get(self, kind: str, name: str, *, timeout: float = 10) -> dict:
        return self._call(kind, "GET", name=name, timeout=timeout)

    def pods(self, deployment: str, *, timeout: float = 10) -> dict:
        return self._call(
            "Pod",
            "GET",
            query=[("labelSelector", "app=" + deployment), ("limit", 20)],
            timeout=timeout,
        )

    def close(self) -> None:
        with self.lock:
            if self._api is not None:
                self._api.close()

    def nodes(self, *, timeout: float = 10) -> dict:
        """Read-only node metadata for the observer CronJob; never used by deployment admission."""
        return self._call("Node", "GET", query=[("limit", 20)], timeout=timeout)
