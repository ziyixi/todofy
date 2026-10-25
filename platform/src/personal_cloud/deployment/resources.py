"""Render the baked Kustomize List; requests contain identities, never Kubernetes objects."""

import json
from copy import deepcopy
from importlib.resources import files

from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb

from ..status_daemon.config import Configuration

NAMES = {
    ("Deployment", "codex-gateway"),
    ("Service", "codex-gateway"),
    ("ConfigMap", "codex-gateway-release"),
    ("Deployment", "newsletter"),
    ("Deployment", "newsletter-config-sync"),
    ("Deployment", "platform-runtime"),
    ("CronJob", "newsletter-daily"),
    ("CronJob", "platform-observer"),
    ("Service", "newsletter"),
    ("Service", "platform-runtime"),
    ("ConfigMap", "newsletter-release"),
    ("ConfigMap", "platform-release"),
    ("ConfigMap", "platform-runtime-config"),
}


def load() -> dict:
    raw = files("personal_cloud").joinpath("resources.json").read_text()
    if len(raw) > 256 * 1024:
        raise ValueError("invalid_resource_asset")
    value = json.loads(raw)
    if (
        not isinstance(value, dict)
        or value.get("apiVersion") != "v1"
        or value.get("kind") != "List"
        or not isinstance(value.get("items"), list)
        or len(value["items"]) != len(NAMES)
        or {
            (item.get("kind"), item.get("metadata", {}).get("name"))
            for item in value["items"]
        }
        != NAMES
    ):
        raise ValueError("invalid_resource_asset")
    return value


def configuration_wire(config: Configuration) -> dict:
    return {
        "version": 1,
        "repository": config.repository,
        "node_key": config.node_key,
        "namespace": config.namespace,
        "expected_daemons": list(config.expected_daemons),
        "workloads": [
            {
                "workload_key": item.key,
                "deployment": item.deployment,
                "container": item.container,
                "release_configmap": item.release_configmap,
                "adapter": item.adapter,
            }
            for item in config.workloads
        ],
    }


def image(config: Configuration, adapter: str, digest: str) -> str:
    suffix = {
        "newsletter": "newsletter",
        "personal-cloud": "platform",
        "codex-gateway": "codex-gateway",
    }[adapter]
    return (
        "ghcr.io/"
        + config.repository.split("/", 1)[0].lower()
        + "/"
        + config.repository.split("/", 1)[1].lower()
        + "-"
        + suffix
        + "@"
        + digest
    )


class Renderer:
    def __init__(self, config: Configuration, *, asset: dict | None = None):
        self.config = config
        self.workloads = {
            item.adapter: item
            for item in config.workloads
            if item.adapter in {"newsletter", "personal-cloud", "codex-gateway"}
        }
        selected = [
            item
            for item in config.workloads
            if item.adapter in {"newsletter", "personal-cloud", "codex-gateway"}
        ]
        if (
            not {"newsletter", "personal-cloud"} <= set(self.workloads)
            or len(selected) != len(self.workloads)
            or len({item.deployment for item in selected}) != len(selected)
            or len({item.release_configmap for item in selected}) != len(selected)
        ):
            raise ValueError("unsupported_release_profile")
        self.asset = load() if asset is None else deepcopy(asset)
        names = {
            (item["kind"], item["metadata"]["name"]) for item in self.asset["items"]
        }
        legacy = {name for name in NAMES if not name[1].startswith("codex-gateway")}
        allowed = (NAMES,) if "codex-gateway" in self.workloads else (NAMES, legacy)
        if names not in allowed or len(self.asset["items"]) != len(names):
            raise ValueError("invalid_resource_asset")

    @staticmethod
    def adapter(name: str) -> str:
        if name.startswith("codex-gateway"):
            return "codex-gateway"
        return "personal-cloud" if name.startswith("platform-") else "newsletter"

    def sources(self, targets):
        selected = {target.workload_key for target in targets}
        return tuple(
            source
            for source in self.asset["items"]
            if (
                workload := self.workloads.get(self.adapter(source["metadata"]["name"]))
            )
            and workload.key in selected
        )

    def render(
        self,
        targets: tuple[pb.ReleaseTarget, ...],
        release_id: str,
        *,
        gate_key: str | None = None,
    ) -> tuple[dict, ...]:
        selected = {target.workload_key: target for target in targets}
        output = []
        for source in self.sources(targets):
            item = deepcopy(source)
            kind, name = item["kind"], item["metadata"]["name"]
            adapter = self.adapter(name)
            workload = self.workloads[adapter]
            target = selected[workload.key]
            item["metadata"]["namespace"] = self.config.namespace
            replacements = {
                "newsletter": self.workloads["newsletter"].deployment,
                "newsletter-release": self.workloads["newsletter"].release_configmap,
                "platform-runtime": self.workloads["personal-cloud"].deployment,
                "platform-release": self.workloads["personal-cloud"].release_configmap,
            }
            if "codex-gateway" in self.workloads:
                gateway = self.workloads["codex-gateway"]
                replacements.update(
                    {
                        "codex-gateway": gateway.deployment,
                        "codex-gateway-release": gateway.release_configmap,
                    }
                )
            item["metadata"]["name"] = replacements.get(name, name)
            if kind == "ConfigMap":
                if name == "platform-runtime-config":
                    item["data"] = {
                        "runtime.json": json.dumps(
                            configuration_wire(self.config),
                            sort_keys=True,
                            separators=(",", ":"),
                        )
                    }
                else:
                    item["data"] = {
                        "source_sha": target.source_sha,
                        "image": image(self.config, adapter, target.image_digest),
                        "request_id": target.request_id,
                    }
            elif kind == "Service":
                item["spec"]["selector"] = {"app": workload.deployment}
            elif kind == "CronJob":
                if name == "newsletter-daily":
                    item["spec"].pop("suspend", None)
                else:
                    item["spec"]["suspend"] = False
                pod = item["spec"]["jobTemplate"]["spec"]["template"]["spec"]
                for container in (*pod.get("initContainers", []), *pod["containers"]):
                    container["image"] = image(
                        self.config, adapter, target.image_digest
                    )
                if name == "platform-observer":
                    for container in (
                        *pod.get("initContainers", []),
                        *pod["containers"],
                    ):
                        variables = container.setdefault("env", [])
                        variables[:] = [
                            value
                            for value in variables
                            if value["name"] != "FLEET_EXPECTED_DAEMONS"
                        ]
                        variables.append(
                            {
                                "name": "FLEET_EXPECTED_DAEMONS",
                                "value": json.dumps(
                                    list(self.config.expected_daemons),
                                    separators=(",", ":"),
                                ),
                            }
                        )
                    for container in pod["containers"]:
                        runtime_url = (
                            "http://"
                            + self.workloads["personal-cloud"].deployment
                            + ":8080/api/v1/nodeStatus"
                        )
                        runtime_configured = False
                        for env in container.get("env", []):
                            if env["name"] == "FLEET_HOST_KEY":
                                env.pop("valueFrom", None)
                                env["value"] = self.config.node_key
                            elif env["name"] == "FLEET_KUBE_NAMESPACE":
                                env.pop("value", None)
                                env["valueFrom"] = {
                                    "fieldRef": {"fieldPath": "metadata.namespace"}
                                }
                            elif env["name"] == "FLEET_RUNTIME_URL":
                                env.pop("valueFrom", None)
                                env["value"] = runtime_url
                                runtime_configured = True
                        if not runtime_configured:
                            container.setdefault("env", []).append(
                                {"name": "FLEET_RUNTIME_URL", "value": runtime_url}
                            )
            elif kind == "Deployment":
                item["spec"]["strategy"] = {"type": "Recreate"}
                item["spec"]["replicas"] = 1
                pod = item["spec"]["template"]
                if name != "newsletter-config-sync":
                    item["spec"]["selector"]["matchLabels"] = {
                        "app": workload.deployment
                    }
                    pod["metadata"]["labels"] = {"app": workload.deployment}
                for container in (
                    *pod["spec"].get("initContainers", []),
                    *pod["spec"]["containers"],
                ):
                    container["image"] = image(
                        self.config, adapter, target.image_digest
                    )
                    if name == "newsletter-config-sync":
                        for env in container.get("env", []):
                            if env["name"] == "NEWSLETTER_CONFIG_REPOSITORY":
                                env["value"] = self.config.repository
                    else:
                        container["name"] = workload.container
                        values = (
                            {
                                "NEWSLETTER_BOOTSTRAP_DRAIN_KEY": gate_key
                                or "release-" + target.source_sha,
                                "NEWSLETTER_RELEASE_REQUEST_ID": target.request_id,
                            }
                            if adapter == "newsletter"
                            else {
                                "CODEX_GATEWAY_RELEASE_REQUEST_ID"
                                if adapter == "codex-gateway"
                                else "PLATFORM_RELEASE_REQUEST_ID": target.request_id
                            }
                        )
                        for env in container.get("env", []):
                            if env["name"] in values:
                                env.pop("valueFrom", None)
                                env["value"] = values.pop(env["name"])
                        container.setdefault("env", []).extend(
                            {"name": key, "value": value}
                            for key, value in values.items()
                        )
            if kind in {"Deployment", "CronJob"}:
                template = item["spec"]
                if kind == "CronJob":
                    template = template["jobTemplate"]["spec"]
                template["template"].setdefault("metadata", {}).setdefault(
                    "annotations", {}
                ).update(
                    {
                        "personal-cloud/source-sha": target.source_sha,
                        "personal-cloud/image-digest": target.image_digest,
                        "personal-cloud/request-id": target.request_id,
                    }
                )
            output.append(item)
        return tuple(output)
