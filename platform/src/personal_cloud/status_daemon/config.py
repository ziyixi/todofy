"""Public workload selection; credentials only arrive through separate environment variables."""

import json
import re
from dataclasses import dataclass

from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import field_rules, format_matches


def _matches(message: type, field: str, value: object) -> bool:
    return isinstance(value, str) and format_matches(
        field_rules(message, field).format, value
    )


@dataclass(frozen=True)
class Workload:
    key: str
    deployment: str
    container: str
    release_configmap: str
    adapter: str


@dataclass(frozen=True)
class Configuration:
    node_key: str
    namespace: str
    workloads: tuple[Workload, ...]
    repository: str


def workloads(text: str) -> tuple[Workload, ...]:
    if len(text) > 16 * 1024:
        raise ValueError("invalid_configuration")
    values = json.loads(text)
    if not isinstance(values, list) or not 1 <= len(values) <= 16:
        raise ValueError("invalid_configuration")
    result = []
    for value in values:
        if not isinstance(value, dict) or set(value) != {
            "workload_key",
            "deployment",
            "container",
            "release_configmap",
            "adapter",
        }:
            raise ValueError("invalid_configuration")
        if not _matches(pb.ReleaseTarget, "workload_key", value["workload_key"]):
            raise ValueError("invalid_configuration")
        if any(
            not isinstance(value[key], str)
            or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value[key])
            for key in ("deployment", "container", "release_configmap")
        ):
            raise ValueError("invalid_configuration")
        if not isinstance(value["adapter"], str) or value["adapter"] not in {
            "newsletter",
            "personal-cloud",
            "deployment",
        }:
            raise ValueError("invalid_configuration")
        result.append(
            Workload(
                value["workload_key"],
                value["deployment"],
                value["container"],
                value["release_configmap"],
                value["adapter"],
            )
        )
    if len({item.key for item in result}) != len(result):
        raise ValueError("invalid_configuration")
    return tuple(sorted(result, key=lambda item: item.key))


def _unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("invalid_configuration")
        value[key] = item
    return value


def configuration(text: str) -> Configuration:
    if len(text) > 16 * 1024:
        raise ValueError("invalid_configuration")
    value = json.loads(text, object_pairs_hook=_unique)
    if (
        not isinstance(value, dict)
        or set(value) != {"version", "node_key", "namespace", "workloads", "repository"}
        or type(value["version"]) is not int
        or value["version"] != 1
        or not _matches(pb.NodeStatus, "node_key", value["node_key"])
        or not isinstance(value["namespace"], str)
        or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", value["namespace"])
        or not isinstance(value["repository"], str)
        or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value["repository"])
    ):
        raise ValueError("invalid_configuration")
    return Configuration(
        value["node_key"],
        value["namespace"],
        workloads(json.dumps(value["workloads"])),
        value["repository"],
    )
