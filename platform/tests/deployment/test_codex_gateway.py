"""Independent inference releases preserve Newsletter work and prior accepted identities."""

import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock

from deploy import verified_snapshot
from fastapi.testclient import TestClient
from personal_cloud.deployment.controller import Controller
from personal_cloud.deployment.kubernetes import DependencyUnavailable
from personal_cloud.deployment.resources import DISCOVERY_LABEL, Renderer
from personal_cloud.status_daemon.config import Workload
from personal_cloud.status_daemon.server import Cache, Service, create_app
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.wire_json import to_wire

from .fixtures import CONFIG, IDENTITY, REQUEST, SHA, TARGETS, Fixture, asset

GATEWAY = Workload(
    "codex-gateway",
    "codex-gateway",
    "codex-gateway",
    "codex-gateway-release",
    "codex-gateway",
)
GATEWAY_ID = "8c5859ae-bab5-4b88-a859-a8c08735bdec"
GATEWAY_SHA = "d" * 40
CONFIGURATION = replace(CONFIG, workloads=(*CONFIG.workloads, GATEWAY))
TARGET = pb.ReleaseTarget(
    workload_key=GATEWAY.key,
    source_sha=GATEWAY_SHA,
    image_digest="sha256:" + "e" * 64,
    request_id=GATEWAY_ID,
)


class GatewayRelease(Fixture, unittest.TestCase):
    def setUp(self):
        self.initialize()
        self.create()
        self.until("done")
        self.at += timedelta(seconds=1)
        self.controller = Controller(
            CONFIGURATION,
            self.store,
            self.kube,
            self.admission,
            Renderer(CONFIGURATION, asset=asset()),
            self.reads,
            source_sha=lambda: SHA,
            process_request_id=REQUEST,
            clock=lambda: self.at,
        )
        self.original_snapshot = self.reads.snapshot
        self.reads.snapshot = self.gateway_snapshot
        self.events.clear()

    def gateway_snapshot(self):
        snapshot = self.original_snapshot()
        phase = (
            self.resource_state.get(("ConfigMap", GATEWAY.release_configmap), {})
            .get("data", {})
            .get("phase")
        )
        value = pb.WorkloadStatus(
            name="workloads/" + GATEWAY.key,
            workload_key=GATEWAY.key,
            process_state="running",
            admission_state="unsupported",
            health_state="healthy",
            observed_at=snapshot.observed_at,
            release=pb.ReleaseStatus(
                state="ready" if phase == "activated" else "pending",
                desired=TARGET,
                actual=replace(TARGET, generation=3),
                observed_generation=3,
                observed_at=snapshot.observed_at,
            ),
        )
        return replace(snapshot, workloads=(value, *snapshot.workloads))

    def create_gateway(self):
        return self.controller.create(
            api.CreateReleaseRequest(
                release_id=GATEWAY_ID,
                request_id=GATEWAY_ID,
                release=pb.Release(targets=(TARGET,)),
            )
        )

    def complete_gateway(self):
        for _ in range(10):
            if self.store.get(GATEWAY_ID).phase == "ready":
                return
            self.assertTrue(self.controller.step())
        self.fail("Gateway release did not converge")

    def test_gateway_release_preserves_frozen_newsletter_and_changes_only_its_resources(
        self,
    ):
        self.admission.state = "frozen"
        self.create_gateway()
        self.complete_gateway()
        self.assertEqual(self.admission.state, "frozen")
        self.assertFalse(any(event[0] == "admission" for event in self.events))
        self.assertEqual(
            {event[2] for event in self.events},
            {GATEWAY.deployment, GATEWAY.release_configmap},
        )
        self.assertEqual(
            self.store.get(IDENTITY).body["targets"],
            [to_wire(target) for target in TARGETS],
        )
        self.assertEqual(
            {
                target["workload_key"]
                for target in self.store.accepted_targets(self.controller.keys)
            },
            {"newsletter", "platform-runtime", "codex-gateway"},
        )

    def test_reconcile_keeps_the_accepted_pair_after_a_gateway_only_release(self):
        self.create_gateway()
        self.complete_gateway()
        resources = self.controller.renderer.render((*TARGETS, TARGET), GATEWAY_ID)
        self.resource_state = {
            (item["kind"], item["metadata"]["name"]): deepcopy(item)
            for item in resources
        }
        self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"] = False

        def get(kind, name, **_):
            try:
                return deepcopy(self.resource_state[(kind, name)])
            except KeyError:
                raise DependencyUnavailable(missing=True) from None

        self.kube.get = Mock(side_effect=get)
        self.kube.dry_run = Mock(side_effect=lambda item, **_: deepcopy(item))
        admission_call = self.admission.call
        self.admission.call = lambda action, key, **_: admission_call(action, key)
        self.assertEqual(self.controller.plan(fresh=True).state, "clean")
        self.resource_state[("Deployment", "newsletter-config-sync")]["spec"][
            "replicas"
        ] = 0
        plan = self.controller.plan(fresh=True)
        self.assertEqual(
            (plan.state, plan.base_release), ("repairable", "releases/" + GATEWAY_ID)
        )
        self.assertIn(
            "newsletter-config-sync", {change.resource_key for change in plan.changes}
        )
        repaired = self.controller.reconcile(
            api.ReconcileReleaseRequest(
                name=plan.base_release,
                etag=plan.base_etag,
                fingerprint=plan.fingerprint,
                request_id="4d5c5d3d-0143-4c3e-a5d9-39c3e4423d4b",
            )
        )
        self.assertEqual(
            {target.workload_key for target in repaired.targets}, self.controller.keys
        )
        self.assertEqual(
            {target.source_sha for target in repaired.targets}, {SHA, GATEWAY_SHA}
        )
        self.assertTrue(
            all(target.request_id == repaired.request_id for target in repaired.targets)
        )

        def snapshot():
            values = []
            for target in repaired.targets:
                newsletter = target.workload_key == "newsletter"
                accepting = self.admission.state == "active"
                stamp = self.at.isoformat().replace("+00:00", "Z")
                values.append(
                    pb.WorkloadStatus(
                        name="workloads/" + target.workload_key,
                        workload_key=target.workload_key,
                        process_state="running",
                        health_state="healthy",
                        admission_state=("accepting" if accepting else "frozen")
                        if newsletter
                        else "unsupported",
                        unknown_count=0 if newsletter else None,
                        observed_at=stamp,
                        release=pb.ReleaseStatus(
                            state="ready" if accepting else "pending",
                            desired=target,
                            actual=replace(target, generation=3),
                            observed_generation=3,
                            observed_at=stamp,
                        ),
                    )
                )
            return pb.NodeStatus(
                name="nodeStatus",
                node_key="vps",
                state="ready",
                observed_at=stamp,
                workloads=tuple(values),
            )

        self.reads.snapshot = snapshot
        identity = repaired.name.split("/")[1]
        for _ in range(25):
            record = self.store.get(identity)
            if record.phase == "ready":
                break
            if record.checkpoint == "install_self":
                self.controller.process_request_id = repaired.request_id
            self.assertTrue(self.controller.step(), self.store.get(identity))
        self.assertEqual(self.store.get(identity).phase, "ready")
        self.assertEqual(
            {
                target["source_sha"]
                for target in self.store.accepted_targets(self.controller.keys)
            },
            {SHA, GATEWAY_SHA},
        )

    def test_new_pair_finishes_before_reconcile_labels_the_older_gateway(self):
        patch = self.kube.patch

        def merge_patch(kind, name, change):
            previous = deepcopy(self.resource_state.get((kind, name), {}))
            patch(kind, name, change)
            for field, value in change.items():
                self.resource_state[(kind, name)][field] = {
                    **previous.get(field, {}),
                    **value,
                }

        self.kube.patch = merge_patch
        self.create_gateway()
        self.complete_gateway()
        gateway = self.resource_state[("Deployment", GATEWAY.deployment)]
        # This accepted independent declaration predates the discovery labels.
        gateway["metadata"]["labels"].pop(DISCOVERY_LABEL)
        gateway["spec"]["template"]["metadata"]["labels"].pop(DISCOVERY_LABEL)
        old_gateway = deepcopy(gateway)
        pair_id = "2af73d3c-28db-41a1-b54c-9a99d8b2250e"
        pair_sha = "f" * 40
        pair = tuple(
            replace(
                target,
                source_sha=pair_sha,
                image_digest="sha256:" + str(index + 1) * 64,
                request_id=pair_id,
            )
            for index, target in enumerate(TARGETS)
        )
        observed = (*pair, TARGET)

        def snapshot():
            accepting = self.admission.state == "active"
            stamp = self.at.isoformat().replace("+00:00", "Z")
            return pb.NodeStatus(
                name="nodeStatus",
                node_key="vps",
                state="ready" if accepting else "degraded",
                observed_at=stamp,
                workloads=tuple(
                    pb.WorkloadStatus(
                        name="workloads/" + target.workload_key,
                        workload_key=target.workload_key,
                        process_state="running",
                        health_state="healthy",
                        admission_state=("accepting" if accepting else "frozen")
                        if target.workload_key == "newsletter"
                        else "unsupported",
                        unknown_count=0
                        if target.workload_key == "newsletter"
                        else None,
                        observed_at=stamp,
                        release=pb.ReleaseStatus(
                            state="ready" if accepting else "pending",
                            desired=target,
                            actual=replace(target, generation=3),
                            observed_generation=3,
                            observed_at=stamp,
                        ),
                    )
                    for target in observed
                ),
            )

        self.reads.snapshot = snapshot
        self.controller.source_sha = lambda: pair_sha
        self.controller.planner.source_sha = self.controller.source_sha
        self.kube.get = Mock(
            side_effect=lambda kind, name, **_: deepcopy(
                self.resource_state[(kind, name)]
            )
        )
        self.kube.dry_run = Mock(side_effect=lambda item, **_: deepcopy(item))
        admission_call = self.admission.call
        self.admission.call = lambda action, key, **_: admission_call(action, key)
        self.at += timedelta(seconds=1)
        self.controller.create(
            api.CreateReleaseRequest(
                release_id=pair_id,
                request_id=pair_id,
                release=pb.Release(targets=pair),
            )
        )
        for _ in range(25):
            record = self.store.get(pair_id)
            if record.phase == "ready":
                break
            if record.checkpoint == "install_self":
                self.controller.process_request_id = pair_id
            self.assertTrue(self.controller.step(), self.store.get(pair_id))
        self.assertEqual(self.store.get(pair_id).phase, "ready")
        self.assertEqual(
            self.resource_state[("Deployment", GATEWAY.deployment)], old_gateway
        )
        service = Service(
            Cache(SimpleNamespace(collect=snapshot)), tuple(self.controller.keys)
        )
        service.summary = self.controller.summary
        service.plan = lambda: self.controller.plan(fresh=True)
        node = service.get("/api/v1/nodeStatus")
        plan = node.reconcile_plan
        self.assertEqual(
            (plan.state, plan.base_release), ("repairable", "releases/" + pair_id)
        )
        self.assertEqual(
            {change.resource_key for change in plan.changes}, {GATEWAY.key}
        )
        # Actual Actions verification accepts the requested pair despite the older gateway's drift.
        self.assertTrue(verified_snapshot(node, pair, "releases/" + pair_id, self.at))
        repaired = self.controller.reconcile(
            api.ReconcileReleaseRequest(
                name=plan.base_release,
                etag=plan.base_etag,
                fingerprint=plan.fingerprint,
                request_id="aab2ba6c-3031-4d3b-963a-4714b93fb2eb",
            )
        )
        frozen = {
            target.workload_key: (target.source_sha, target.image_digest)
            for target in observed
        }
        self.assertEqual(
            {
                target.workload_key: (target.source_sha, target.image_digest)
                for target in repaired.targets
            },
            frozen,
        )
        self.assertEqual(repaired.source_release, "releases/" + pair_id)
        observed = repaired.targets
        identity = repaired.name.split("/")[1]
        for _ in range(25):
            record = self.store.get(identity)
            if record.phase == "ready":
                break
            if record.checkpoint == "install_self":
                self.controller.process_request_id = repaired.request_id
            self.assertTrue(self.controller.step(), self.store.get(identity))
        self.assertEqual(self.store.get(identity).phase, "ready")
        for workload in CONFIGURATION.workloads:
            deployment = self.resource_state[("Deployment", workload.deployment)]
            pod = deployment["spec"]["template"]
            self.assertEqual(
                deployment["metadata"]["labels"][DISCOVERY_LABEL], workload.key
            )
            self.assertEqual(pod["metadata"]["labels"][DISCOVERY_LABEL], workload.key)
            source, digest = frozen[workload.key]
            self.assertEqual(
                pod["metadata"]["annotations"]["personal-cloud/source-sha"], source
            )
            self.assertTrue(
                pod["spec"]["containers"][0]["image"].endswith("@" + digest)
            )
        self.assertEqual(self.controller.plan(fresh=True).state, "clean")

    def test_missing_gateway_mount_reports_repairable_drift_through_node_status(self):
        self.create_gateway()
        self.complete_gateway()
        resources = self.controller.renderer.render((*TARGETS, TARGET), GATEWAY_ID)
        self.resource_state = {
            (item["kind"], item["metadata"]["name"]): deepcopy(item)
            for item in resources
        }
        self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"] = False
        pod = self.resource_state[("Deployment", "codex-gateway")]["spec"]["template"][
            "spec"
        ]
        # A live Pod without the declared login mount is drift that a release repairs.
        pod["volumes"] = []
        pod["containers"][0]["volumeMounts"] = []

        def get(kind, name, **_):
            return deepcopy(self.resource_state[(kind, name)])

        self.kube.get = Mock(side_effect=get)
        self.kube.dry_run = Mock(side_effect=lambda item, **_: deepcopy(item))
        admission_call = self.admission.call
        self.admission.call = lambda action, key, **_: admission_call(action, key)
        service = Service(
            Cache(SimpleNamespace(collect=self.gateway_snapshot)),
            tuple(item.key for item in CONFIGURATION.workloads),
        )
        service.summary = self.controller.summary
        service.plan = self.controller.plan
        with TestClient(create_app(service)) as client:
            response = client.get("/api/v1/nodeStatus")
        self.assertEqual(response.status_code, 200)
        plan = response.json()["reconcile_plan"]
        self.assertEqual(plan["state"], "repairable")
        self.assertEqual(
            plan["changes"],
            [
                {
                    "resource_key": "codex-gateway",
                    "action": "update",
                    "reason_code": "RUNTIME_FIELDS_CHANGED",
                }
            ],
        )

    def test_gateway_pod_mounts_only_the_existing_login_volume(self):
        resources = self.controller.renderer.render((TARGET,), GATEWAY_ID)
        self.assertEqual(len(resources), 3)
        deployment = next(item for item in resources if item["kind"] == "Deployment")
        pod = deployment["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 10001)
        self.assertEqual(pod["securityContext"]["runAsGroup"], 10001)
        self.assertNotIn("initContainers", pod)
        self.assertEqual(
            pod["volumes"],
            [
                {
                    "name": "auth",
                    "persistentVolumeClaim": {"claimName": "newsletter-auth"},
                },
            ],
        )
        container = pod["containers"][0]
        self.assertEqual(
            container["volumeMounts"],
            [{"name": "auth", "mountPath": "/var/lib/newsletter-auth"}],
        )
        environment = {
            item["name"]: item["value"] for item in container["env"] if "value" in item
        }
        self.assertEqual(environment["CODEX_HOME"], "/var/lib/newsletter-auth")
        self.assertNotIn("DATA_DIR", environment)
        self.assertEqual(container["ports"][0]["hostIP"], "127.0.0.1")
        self.assertEqual(container["ports"][0]["hostPort"], 18766)
        secrets = [
            item["valueFrom"]["secretKeyRef"]
            for item in container["env"]
            if "valueFrom" in item
        ]
        self.assertEqual(secrets, [])
        self.assertNotIn("ACCESS_ISSUER", environment)
        self.assertNotIn("ACCESS_AUDIENCE", environment)
