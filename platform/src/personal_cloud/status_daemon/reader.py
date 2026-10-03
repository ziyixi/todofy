"""Fixed bounded observations; this reader never mutates resources or executes commands."""

import time
from datetime import datetime, timezone

import httpx
from ziyixi_proto.http_routes import decode_json_body
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

from ..deployment.kubernetes import (
    DEFAULT_CA,
    DEFAULT_TOKEN,
    Client,
    DependencyUnavailable,
)
from .adapters import Business, local_process, newsletter
from .config import Configuration, Workload
from .evidence import timestamp, workload

MONITOR_URL = "http://newsletter:8080/internal/monitoring/status"
TOKEN_FILE = DEFAULT_TOKEN
CA_FILE = DEFAULT_CA


class ReadError(RuntimeError):
    def __init__(self, *, missing: bool = False):
        super().__init__("read_unavailable")
        self.missing = missing


def read_json(
    url: str,
    headers: dict,
    limit: int,
    timeout: float,
    *,
    client: httpx.Client | None = None,
) -> dict:
    """Private monitor GET, using httpx's transport with no redirects or environment proxy."""
    deadline = time.monotonic() + min(3, timeout)

    def read(active):
        try:
            with active.stream(
                "GET",
                url,
                headers={**headers, "Accept-Encoding": "identity"},
                timeout=min(3, timeout),
            ) as response:
                if response.status_code == 404:
                    raise ReadError(missing=True)
                if (
                    response.status_code != 200
                    or response.headers.get("content-type", "")
                    .split(";", 1)[0]
                    .strip()
                    .lower()
                    != "application/json"
                    or response.headers.get("content-encoding", "identity").lower()
                    != "identity"
                ):
                    raise ReadError()
                raw = bytearray()
                for chunk in response.iter_raw(chunk_size=1024):
                    if len(raw) + len(chunk) > limit or time.monotonic() >= deadline:
                        raise ReadError()
                    raw.extend(chunk)
            return decode_json_body(bytes(raw), max_bytes=limit)
        except (httpx.HTTPError, OSError, ValueError):
            raise ReadError() from None

    if client is not None:
        return read(client)
    with httpx.Client(trust_env=False, follow_redirects=False) as active:
        return read(active)


class Reader:
    def __init__(
        self,
        config: Configuration,
        monitor_token: str,
        process_request_id: str,
        *,
        token_file: str = TOKEN_FILE,
        ca_file: str = CA_FILE,
        kube_client=None,
        transport=read_json,
        clock=lambda: datetime.now(timezone.utc),
        monotonic=time.monotonic,
    ):
        self.config, self.monitor_token, self.process_request_id = (
            config,
            monitor_token,
            process_request_id,
        )
        self.kube = (
            kube_client
            if kube_client is not None
            else Client(config.namespace, token_file=token_file, ca_file=ca_file)
        )
        self.transport, self.clock, self.monotonic = transport, clock, monotonic

    def close(self):
        self.kube.close()

    def _remaining(self, deadline: float) -> float:
        left = deadline - self.monotonic()
        if left <= 0:
            raise ReadError()
        return left

    def _monitor(self, deadline: float) -> dict:
        token = self.monitor_token
        if (
            not token
            or len(token) > 16384
            or any(character.isspace() for character in token)
        ):
            raise ReadError()
        return self.transport(
            MONITOR_URL,
            {"Authorization": "Bearer " + token, "Accept": "application/json"},
            16 * 1024,
            self._remaining(deadline),
        )

    def _optional(self, kind: str, name: str, deadline: float) -> dict | None:
        try:
            remaining = self._remaining(deadline)
            return (
                self.kube.pods(name, timeout=remaining)
                if kind == "Pod"
                else self.kube.get(kind, name, timeout=remaining)
            )
        except DependencyUnavailable as error:
            if error.missing:
                return None
            raise ReadError() from None

    def _observe(
        self, item: Workload, deadline: float
    ) -> tuple[pb.WorkloadStatus, bool]:
        try:
            target = self._optional("ConfigMap", item.release_configmap, deadline)
            deployment = self._optional("Deployment", item.deployment, deadline)
            pods = self._optional("Pod", item.deployment, deadline)
            business = Business(admission="unsupported", health="unsupported")
            if item.adapter == "newsletter":
                try:
                    business = newsletter(self._monitor(deadline))
                except ReadError:
                    business = Business()
            elif item.adapter == "personal-cloud":
                business = local_process(self.process_request_id)
            # Configuration changes during the observation cannot lend their identity to a different physical pod.
            if self._optional("ConfigMap", item.release_configmap, deadline) != target:
                raise ReadError()
            return workload(
                item, target, deployment, pods, business, self.clock()
            ), False
        except ReadError:
            return workload(
                item, None, None, None, Business(), self.clock(), unavailable=True
            ), True

    def collect(self) -> pb.NodeStatus:
        # One bounded collection cannot spend sixteen per-workload network timeout budgets.
        deadline = self.monotonic() + 12
        observations = [self._observe(item, deadline) for item in self.config.workloads]
        values = tuple(value for value, _ in observations)
        if all(failed for _, failed in observations):
            state = "unavailable"
        elif all(value.process_state == "missing" for value in values):
            state = "missing"
        elif any(value.release.state == "unknown" for value in values):
            state = "unknown"
        elif any(
            value.release.state != "ready"
            or value.health_state not in {"healthy", "unsupported"}
            for value in values
        ):
            state = "degraded"
        else:
            state = "ready"
        result = pb.NodeStatus(
            name="nodeStatus",
            node_key=self.config.node_key,
            state=state,
            observed_at=timestamp(self.clock()),
            workloads=values,
        )
        return from_wire(pb.NodeStatus, to_wire(result), strict=True).message
