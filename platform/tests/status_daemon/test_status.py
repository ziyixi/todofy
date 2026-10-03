"""Content-free synthetic resources; no host, Kubernetes credentials or production calls."""

import json
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from personal_cloud.status_daemon.adapters import Business, newsletter
from personal_cloud.status_daemon.config import Workload, configuration
from personal_cloud.status_daemon.evidence import workload
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
IMAGE = "ghcr.io/example/todofy-newsletter@" + DIGEST
REQUEST = "a233fd9a-19d5-4f61-960d-884e1a490b8a"
AT = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
CONFIG = Workload(
    "newsletter", "newsletter", "newsletter", "newsletter-release", "newsletter"
)


def target(phase="activated"):
    return {
        "data": {
            "request_id": REQUEST,
            "source_sha": SHA,
            "image": IMAGE,
            "phase": phase,
        }
    }


def deployment():
    return {
        "metadata": {"generation": 7},
        "spec": {
            "replicas": 1,
            "template": {
                "spec": {"containers": [{"name": "newsletter", "image": IMAGE}]}
            },
        },
        "status": {
            "observedGeneration": 7,
            "replicas": 1,
            "readyReplicas": 1,
            "updatedReplicas": 1,
            "availableReplicas": 1,
        },
    }


def pods():
    return {
        "metadata": {},
        "items": [
            {
                "metadata": {},
                "spec": {"containers": [{"name": "newsletter", "image": IMAGE}]},
                "status": {
                    "phase": "Running",
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "containerStatuses": [
                        {
                            "name": "newsletter",
                            "ready": True,
                            "imageID": "docker-pullable://" + IMAGE,
                            "state": {"running": {}},
                        }
                    ],
                },
            }
        ],
    }


def monitor():
    return {
        "version": 1,
        "worker_healthy": True,
        "drain_state": "active",
        "queued_count": 0,
        "inflight_count": 0,
        "unknown_count": 0,
        "build_source_sha": SHA,
        "release_request_id": REQUEST,
    }


def observe(*, wanted=None, deploy=None, running=None, business=None):
    return workload(
        CONFIG,
        wanted if wanted is not None else target(),
        deploy if deploy is not None else deployment(),
        running if running is not None else pods(),
        business if business is not None else newsletter(monitor()),
        AT,
    )


class Evidence(unittest.TestCase):
    def test_shared_generated_producer_and_consumer_agree(self):
        value = observe()
        wire = to_wire(value)
        self.assertEqual(from_wire(pb.WorkloadStatus, wire, strict=True).message, value)
        self.assertEqual(value.release.state, "ready")
        self.assertEqual(
            value.release.actual,
            pb.ReleaseTarget(
                workload_key="newsletter",
                source_sha=SHA,
                image_digest=DIGEST,
                request_id=REQUEST,
                generation=7,
            ),
        )
        self.assertEqual(
            (value.process_state, value.admission_state, value.health_state),
            ("running", "accepting", "healthy"),
        )

    def test_actual_never_comes_from_desired_or_annotations(self):
        deploy = deployment()
        deploy["metadata"]["annotations"] = {
            "personal-cloud/source-sha": SHA,
            "personal-cloud/request-id": REQUEST,
        }
        value = observe(
            deploy=deploy,
            business=Business(
                worker_healthy=True, admission="accepting", health="healthy"
            ),
        )
        self.assertIsNone(value.release.actual)
        self.assertEqual(value.release.state, "unknown")
        self.assertIsNotNone(value.release.desired)

    def test_invalid_desired_identity_does_not_replace_verified_actual(self):
        for key, value in (
            ("request_id", "unconfigured"),
            ("source_sha", "a"),
            ("image", "ghcr.io/example/todofy-newsletter:latest"),
            ("phase", []),
        ):
            desired = target()
            desired["data"][key] = value
            with self.subTest(key=key):
                result = observe(wanted=desired)
                self.assertEqual(result.release.state, "unknown")
                self.assertEqual(result.release.actual.source_sha, SHA)

    def test_actual_digest_and_baked_source_can_disagree_with_target(self):
        for business in (
            Business(
                worker_healthy=True,
                admission="accepting",
                health="healthy",
                source_sha="c" * 40,
                request_id=REQUEST,
            ),
            Business(
                worker_healthy=True,
                admission="accepting",
                health="healthy",
                source_sha=SHA,
                request_id="bccf3a43-0499-4592-ad0c-126832e5d90b",
            ),
        ):
            with self.subTest(business=business):
                result = observe(business=business)
                self.assertEqual(result.release.state, "degraded")
                self.assertIsNotNone(result.release.actual)
        desired = target()
        desired["data"]["image"] = IMAGE.replace("b" * 64, "c" * 64)
        self.assertEqual(observe(wanted=desired).release.actual.image_digest, DIGEST)
        self.assertEqual(observe(wanted=desired).release.state, "degraded")

    def test_source_request_and_bare_runtime_config_digest_never_prove_ready(self):
        for process in (
            {**monitor(), "build_source_sha": None},
            {**monitor(), "release_request_id": None},
            {**monitor(), "build_source_sha": "a"},
        ):
            with self.subTest(process=process):
                result = observe(business=newsletter(process))
                self.assertEqual(result.release.state, "unknown")
                self.assertIsNone(result.release.actual)
        running = pods()
        running["items"][0]["status"]["containerStatuses"][0]["imageID"] = (
            "containerd://" + DIGEST
        )
        self.assertNotEqual(observe(running=running).release.state, "ready")
        self.assertIsNone(observe(running=running).release.actual)

    def test_pod_ready_does_not_mean_the_application_admits_work(self):
        for drain in ("draining", "frozen"):
            with self.subTest(drain=drain):
                result = observe(
                    business=newsletter({**monitor(), "drain_state": drain})
                )
                self.assertEqual(
                    (result.process_state, result.health_state, result.release.state),
                    ("running", "healthy", "paused"),
                )
                self.assertEqual(result.admission_state, drain)
        result = observe(business=newsletter({**monitor(), "worker_healthy": False}))
        self.assertEqual(
            (result.process_state, result.health_state, result.release.state),
            ("running", "unhealthy", "degraded"),
        )

    def test_unknown_business_operations_and_release_success_are_separate(self):
        result = observe(
            business=newsletter({**monitor(), "unknown_count": 2, "inflight_count": 3})
        )
        self.assertEqual(
            (
                result.release.state,
                result.health_state,
                result.active_count,
                result.unknown_count,
            ),
            ("ready", "degraded", 3, 2),
        )

    def test_publisher_activation_is_a_separate_gate(self):
        for phase in ("target", "applying"):
            with self.subTest(phase=phase):
                result = observe(wanted=target(phase))
                self.assertEqual(result.release.state, "pending")
                self.assertIsNotNone(result.release.actual)

    def test_missing_generation_is_optional_unknown_not_fake_zero(self):
        for key in deployment()["status"]:
            deploy = deployment()
            del deploy["status"][key]
            with self.subTest(missing=key):
                result = observe(deploy=deploy)
                self.assertEqual(result.release.state, "unknown")
                self.assertIsNone(result.release.actual)
                if key == "observedGeneration":
                    self.assertNotIn("observed_generation", to_wire(result.release))
        deploy = deployment()
        deploy["status"]["observedGeneration"] = True
        self.assertIsNone(observe(deploy=deploy).release.observed_generation)

    def test_rollout_lag_multiple_pods_and_terminating_pods_are_not_ready(self):
        deploy = deployment()
        deploy["status"]["observedGeneration"] = 6
        self.assertIsNone(observe(deploy=deploy).release.actual)
        two = pods()
        two["items"].append(deepcopy(two["items"][0]))
        dying = pods()
        dying["items"][0]["metadata"]["deletionTimestamp"] = "2026-10-02T12:00:00Z"
        waiting = pods()
        waiting["items"][0]["status"]["containerStatuses"][0]["state"] = {"waiting": {}}
        for resource in (two, dying, waiting, {"items": []}):
            with self.subTest(resource=resource):
                result = observe(running=resource)
                self.assertNotEqual(result.release.state, "ready")
                self.assertIsNone(result.release.actual)

    def test_upstream_shape_and_capabilities_are_strict(self):
        for process in (
            {},
            {**monitor(), "private": "never-return"},
            {**monitor(), "unknown_count": -1},
            {**monitor(), "worker_healthy": "true"},
        ):
            with self.subTest(process=process):
                result = observe(business=newsletter(process))
                self.assertEqual(
                    (result.health_state, result.admission_state, result.release.state),
                    ("unknown", "unknown", "unknown"),
                )
        config = Workload("job", "job", "job", "job-release", "deployment")
        result = workload(
            config,
            None,
            None,
            None,
            Business(admission="unsupported", health="unsupported"),
            AT,
        )
        self.assertEqual(
            (
                result.process_state,
                result.admission_state,
                result.health_state,
                result.release.state,
            ),
            ("missing", "unsupported", "unsupported", "missing"),
        )


class Config(unittest.TestCase):
    def value(self):
        return {
            "version": 1,
            "node_key": "vps",
            "namespace": "personal-cloud",
            "repository": "example/project",
            "workloads": [
                {
                    "workload_key": "newsletter",
                    "deployment": "newsletter",
                    "container": "newsletter",
                    "release_configmap": "newsletter-release",
                    "adapter": "newsletter",
                }
            ],
        }

    def test_selected_aliases_are_unique_bounded_sorted_and_never_provider_names(self):
        value = self.value()
        self.assertEqual(configuration(json.dumps(value)).workloads, (CONFIG,))
        for change in (
            {**value, "version": True},
            {**value, "node_key": "private.example.com"},
            {**value, "namespace": "../secret"},
            {**value, "workloads": value["workloads"] * 2},
            {**value, "workloads": []},
            {**value, "credential": "forbidden"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                configuration(json.dumps(change))
        with self.assertRaises(ValueError):
            configuration('{"version":1,"version":1}')


if __name__ == "__main__":
    unittest.main()
