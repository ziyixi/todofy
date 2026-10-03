"""Ordinary kubectl operations bounded to the stopped bootstrap's fixed runtime."""

import re
import time

import cluster
from repair_checks import decode

from config import require

DEPLOYMENTS = ("platform-runtime", "newsletter", "newsletter-config-sync")
SELECTOR = "app in (platform-runtime,newsletter,newsletter-config-sync)"


def declared_fields(actual, expected):
    """Retain every declared field while permitting Kubernetes API defaults."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and declared_fields(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(actual) == len(expected)
            and all(
                declared_fields(current, wanted)
                for current, wanted in zip(actual, expected, strict=True)
            )
        )
    return type(actual) is type(expected) and actual == expected


class Runtime:
    def __init__(self, namespace):
        self.namespace = namespace

    def call(self, args, **options):
        return cluster.kubectl(["-n", self.namespace, *args], **options)

    def get(self, kind, name=None):
        args = ["get", kind]
        if name:
            args.append(name)
        args += ["-o", "json"]
        return decode(self.call(args).stdout)

    def admission(self, previous_sha):
        value = decode(
            self.call(
                [
                    "exec",
                    "deployment/newsletter",
                    "--",
                    "newsletter",
                    "admin",
                    "drain",
                    "status",
                ]
            ).stdout
        )
        require(
            set(value)
            == {
                "version",
                "request_key",
                "state",
                "busy",
                "inflight",
                "unknown",
                "queued",
            }
            and type(value["version"]) is int
            and value["version"] == 1
            and value["request_key"] == "release-" + previous_sha
            and value["state"] in {"draining", "frozen"}
            and value["busy"] is False,
            "REPAIR_ADMISSION_NOT_QUIET",
        )
        for name in ("inflight", "unknown", "queued"):
            require(
                isinstance(value[name], dict)
                and value[name]
                and all(
                    type(count) is int and count >= 0 for count in value[name].values()
                ),
                "REPAIR_ADMISSION_STATUS_INVALID",
            )
        require(not any(value["inflight"].values()), "REPAIR_ADMISSION_NOT_QUIET")
        return {name: value[name] for name in ("unknown", "queued")}

    def daily_jobs(self):
        require(
            self.get("cronjob", "newsletter-daily")["spec"].get("suspend") is True,
            "REPAIR_DAILY_NOT_SUSPENDED",
        )
        jobs = self.get("jobs")
        require(not jobs.get("metadata", {}).get("continue"), "REPAIR_JOB_LIST_INVALID")
        require(len(jobs.get("items", [])) <= 128, "REPAIR_JOB_LIST_INVALID")
        found = []
        for item in jobs["items"]:
            if any(
                owner.get("kind") == "CronJob"
                and owner.get("name") == "newsletter-daily"
                for owner in item["metadata"].get("ownerReferences", [])
            ):
                status = item.get("status", {})
                require(
                    not status.get("active")
                    and any(
                        condition.get("type") in {"Complete", "Failed"}
                        and condition.get("status") == "True"
                        for condition in status.get("conditions", [])
                    ),
                    "REPAIR_DAILY_JOB_RUNNING",
                )
                found.append(item["metadata"]["uid"])
        return sorted(found)

    def expected(self, old, new=None, *, first=False):
        variants = [old] if new is None else [old, new]
        for name in DEPLOYMENTS:
            current = self.get("deployment", name)
            require(
                current["spec"].get("replicas") in ({1} if first else {0, 1}),
                "REPAIR_RUNTIME_CHANGED",
            )
            pod = current["spec"]["template"]["spec"]
            allowed = [
                next(
                    item
                    for item in value["items"]
                    if item["kind"] == "Deployment" and item["metadata"]["name"] == name
                )["spec"]["template"]["spec"]
                for value in variants
            ]
            # Ignore API defaultMode/readOnly defaults, retain fixed mounts and startup identities.
            require(
                any(declared_fields(pod, wanted) for wanted in allowed),
                "REPAIR_RUNTIME_CHANGED",
            )
            if first:
                pods = decode(
                    self.call(["get", "pods", "-l", "app=" + name, "-o", "json"]).stdout
                )
                require(
                    len(pods.get("items", [])) == 1, "REPAIR_PHYSICAL_IMAGE_INVALID"
                )
                physical = pods["items"][0]
                require(
                    physical.get("status", {}).get("phase") == "Running",
                    "REPAIR_PHYSICAL_IMAGE_INVALID",
                )
                for container in pod["containers"]:
                    status = next(
                        item
                        for item in physical["status"]["containerStatuses"]
                        if item["name"] == container["name"]
                    )
                    pulled = re.fullmatch(
                        r"(?:docker-pullable://)?[a-z0-9][a-z0-9._:/-]*@(sha256:[0-9a-f]{64})",
                        status.get("imageID", ""),
                    )
                    require(
                        pulled is not None
                        and pulled.group(1) == container["image"].split("@", 1)[1]
                        and status.get("ready") is True,
                        "REPAIR_PHYSICAL_IMAGE_INVALID",
                    )
        for name in ("newsletter-release", "platform-release"):
            current = self.get("configmap", name)
            require(
                any(
                    current.get("data")
                    == next(
                        item
                        for item in value["items"]
                        if item["kind"] == "ConfigMap"
                        and item["metadata"]["name"] == name
                    )["data"]
                    for value in variants
                ),
                "REPAIR_RELEASE_CHANGED",
            )

    def stop(self):
        # Stop the controller before business processes. No failure starts them again.
        for name in DEPLOYMENTS:
            self.call(["scale", "deployment/" + name, "--replicas=0"])
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            value = decode(
                self.call(["get", "pods", "-l", SELECTOR, "-o", "json"]).stdout
            )
            require(
                not value.get("metadata", {}).get("continue"), "REPAIR_POD_LIST_INVALID"
            )
            if not value.get("items"):
                return
            time.sleep(2)
        require(False, "REPAIR_PROCESS_STOP_TIMEOUT")

    def gate_job(self, value):
        name = value["metadata"]["name"]
        existing = self.call(["get", "job", name, "--ignore-not-found", "-o", "json"])
        if existing.stdout.strip():
            previous = decode(existing.stdout)
            require(
                previous["metadata"].get("annotations")
                == value["metadata"]["annotations"],
                "REPAIR_JOB_CONFLICT",
            )
            self.call(
                [
                    "delete",
                    "job",
                    name,
                    "--cascade=foreground",
                    "--wait=true",
                    "--timeout=60s",
                ],
                timeout=70,
            )
        cluster.apply(value)
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            status = self.get("job", name).get("status", {})
            require(not status.get("failed"), "REPAIR_GATE_JOB_FAILED")
            if any(
                item.get("type") == "Complete" and item.get("status") == "True"
                for item in status.get("conditions", [])
            ):
                receipt = decode(
                    self.call(
                        ["logs", "job/" + name, "--tail=1", "--limit-bytes=16384"]
                    ).stdout
                )
                require(
                    set(receipt)
                    == {"version", "state", "request_key", "unknown", "queued"}
                    and receipt["version"] == 1
                    and receipt["state"] == "frozen",
                    "REPAIR_GATE_RECEIPT_INVALID",
                )
                return receipt
            time.sleep(2)
        require(False, "REPAIR_GATE_JOB_TIMEOUT")
