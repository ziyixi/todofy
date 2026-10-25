"""Independent inference releases preserve Newsletter work and prior accepted identities."""

import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from unittest.mock import Mock

from personal_cloud.deployment.controller import Controller
from personal_cloud.deployment.kubernetes import DependencyUnavailable
from personal_cloud.deployment.resources import Renderer
from personal_cloud.status_daemon.config import Workload
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.wire_json import to_wire

from .test_release import CONFIG, IDENTITY, REQUEST, SHA, TARGETS, Fixture, asset

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

    def test_gateway_pod_uses_only_its_bearer_and_the_existing_codex_auth_volume(self):
        resources = self.controller.renderer.render((TARGET,), GATEWAY_ID)
        self.assertEqual(len(resources), 3)
        deployment = next(item for item in resources if item["kind"] == "Deployment")
        pod = deployment["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 10001)
        self.assertEqual(
            pod["volumes"],
            [
                {
                    "name": "auth",
                    "persistentVolumeClaim": {"claimName": "newsletter-auth"},
                }
            ],
        )
        container = pod["containers"][0]
        self.assertEqual(container["ports"][0]["hostIP"], "127.0.0.1")
        self.assertEqual(container["ports"][0]["hostPort"], 18766)
        secrets = [
            item["valueFrom"]["secretKeyRef"]
            for item in container["env"]
            if "valueFrom" in item
        ]
        self.assertEqual(
            secrets, [{"name": "codex-gateway-settings", "key": "CODEX_GATEWAY_TOKEN"}]
        )
