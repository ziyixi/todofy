"""Real baked manifests and SDK HTTP transport against an isolated resource map."""

import json
import unittest
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from personal_cloud.deployment.kubernetes import Client
from urllib3.response import HTTPResponse
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.rpc_status import RpcError

from .test_release import CONFIG, CONTINUE, IDENTITY, REQUEST, TARGETS, Fixture

COLLECTIONS = {
    "deployments": "Deployment",
    "cronjobs": "CronJob",
    "services": "Service",
    "configmaps": "ConfigMap",
}


def merge_fields(current, patch_value):
    """Provider defaults/status survive apply; declared values replace their fields."""
    value = deepcopy(current)
    for key, item in patch_value.items():
        value[key] = (
            merge_fields(value.get(key, {}), item)
            if isinstance(item, dict) and isinstance(value.get(key, {}), dict)
            else deepcopy(item)
        )
    return value


class ManifestAcceptance(Fixture, unittest.TestCase):
    def setUp(self):
        self.initialize()
        self.create()
        self.until("done")
        self.resource_state = {
            (item["kind"], item["metadata"]["name"]): deepcopy(item)
            for item in self.controller.renderer.render(
                self.controller.release(self.store.get(IDENTITY)).targets, IDENTITY
            )
        }
        self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"] = False
        for key, resource in self.resource_state.items():
            resource["metadata"].update(generation=3, resourceVersion="17")
            if key[0] == "ConfigMap" and key[1].endswith("-release"):
                resource["data"]["phase"] = "activated"
        self.requests = []
        transport = patch(
            "kubernetes.client.rest.urllib3.PoolManager.request",
            autospec=True,
            side_effect=self.http_request,
        )
        transport.start()
        self.addCleanup(transport.stop)
        token = Path(self.directory.name) / "token"
        token.write_text("synthetic-projected-pod-identity")
        self.kube = Client(
            CONFIG.namespace, token_file=str(token), ca_file="synthetic-ca"
        )
        self.addCleanup(self.kube.close)
        self.controller.kube = self.controller.planner.kube = self.kube
        self.reads.snapshot = self.physical_snapshot
        admission_call = self.admission.call
        self.admission.call = lambda action, key, **_: admission_call(action, key)
        self.events.clear()

    def http_request(self, manager, method, url, **options):
        parsed = urlsplit(url)
        self.assertEqual(parsed.hostname, "kubernetes.default.svc")
        parts = parsed.path.split("/")
        self.assertEqual(parts[-3], CONFIG.namespace)
        key = (COLLECTIONS[parts[-2]], parts[-1])
        query = parse_qs(parsed.query)
        body = json.loads(options["body"]) if method == "PATCH" else None
        dry_run = query.get("dryRun") == ["All"]
        self.requests.append((method, key, deepcopy(body), dry_run, query))
        if method == "GET":
            value = deepcopy(self.resource_state[key])
        else:
            self.assertEqual(method, "PATCH")
            current = self.resource_state[key]
            value = merge_fields(current, body)
            if (
                key[0] == "Deployment"
                and current["spec"]["template"] != value["spec"]["template"]
            ):
                value["metadata"]["generation"] += 1
            if not dry_run:
                self.resource_state[key] = deepcopy(value)
        return HTTPResponse(
            body=json.dumps(value).encode(),
            status=200,
            headers={"Content-Type": "application/json"},
        )

    def physical_snapshot(self):
        values = []
        source_images = {target.image_digest: target.source_sha for target in TARGETS}
        for previous, workload in zip(
            Fixture.snapshot(self).workloads, CONFIG.workloads, strict=True
        ):
            deployment = self.resource_state[("Deployment", workload.deployment)]
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            config = self.resource_state[("ConfigMap", workload.release_configmap)][
                "data"
            ]
            request_name = (
                "NEWSLETTER_RELEASE_REQUEST_ID"
                if workload.adapter == "newsletter"
                else "PLATFORM_RELEASE_REQUEST_ID"
            )
            request_id = next(
                item["value"]
                for item in container["env"]
                if item["name"] == request_name
            )
            image_digest = container["image"].split("@", 1)[1]
            generation = deployment["metadata"]["generation"]
            actual = pb.ReleaseTarget(
                workload_key=workload.key,
                image_digest=image_digest,
                source_sha=source_images.get(image_digest, "f" * 40),
                request_id=request_id,
                generation=generation,
            )
            desired = pb.ReleaseTarget(
                workload_key=workload.key,
                source_sha=config["source_sha"],
                image_digest=config["image"].split("@", 1)[1],
                request_id=config["request_id"],
            )
            values.append(
                replace(
                    previous,
                    release=pb.ReleaseStatus(
                        state="ready"
                        if config["phase"] == "activated"
                        and self.admission.state == "active"
                        else "pending",
                        desired=desired,
                        actual=actual,
                        observed_generation=generation,
                        observed_at=previous.observed_at,
                    ),
                )
            )
        return replace(Fixture.snapshot(self), workloads=tuple(values))

    def request(self, identity=CONTINUE):
        plan = self.controller.plan(fresh=True)
        return api.ReconcileReleaseRequest(
            name=plan.base_release,
            etag=plan.base_etag,
            fingerprint=plan.fingerprint,
            request_id=identity,
        )

    def mutations(self):
        return [item for item in self.requests if item[0] == "PATCH" and not item[3]]

    def drift_templates(self):
        newsletter = self.resource_state[("Deployment", "newsletter")]["spec"][
            "template"
        ]["spec"]
        newsletter["containers"][0]["readinessProbe"]["httpGet"]["path"] = "/broken"
        newsletter["securityContext"]["runAsUser"] = 12345
        newsletter["volumes"][0]["persistentVolumeClaim"]["claimName"] = (
            "untrusted-other-volume"
        )
        platform = self.resource_state[("Deployment", "platform-runtime")]["spec"][
            "template"
        ]["spec"]
        platform["containers"][0]["image"] = (
            "ghcr.io/example/project-platform@sha256:" + "d" * 64
        )
        sync = self.resource_state[("Deployment", "newsletter-config-sync")]["spec"][
            "template"
        ]["spec"]
        sync["containers"][0]["env"][0]["value"] = "synthetic-other-repository"

    def test_declared_defaults_status_and_clean_noop_do_not_restart(self):
        before = deepcopy(self.resource_state)
        platform = self.resource_state[("Deployment", "platform-runtime")]
        platform["status"] = {"availableReplicas": 1, "observedGeneration": 3}
        platform["spec"]["template"]["spec"]["dnsPolicy"] = "ClusterFirst"
        observed = deepcopy(self.resource_state)
        request = self.request()
        self.assertEqual(self.controller.plan().state, "clean")
        self.assertEqual(
            self.controller.reconcile(request).name, "releases/" + IDENTITY
        )
        self.controller.reconcile(request)
        self.assertFalse(self.controller.step())
        self.assertEqual(self.resource_state, observed)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(
            platform["metadata"]["generation"],
            before[("Deployment", "platform-runtime")]["metadata"]["generation"],
        )
        self.assertTrue(
            all(item[4].get("force") == ["false"] for item in self.requests if item[3])
        )

    def test_full_template_repair_keeps_frozen_images_and_reaches_physical_ready(self):
        self.drift_templates()
        plan = self.controller.plan(fresh=True)
        self.assertEqual(
            {item.resource_key for item in plan.changes},
            {
                "newsletter",
                "newsletter-config-sync",
                "platform-runtime",
            },
        )
        repaired = self.controller.reconcile(self.request())
        for _ in range(30):
            current = self.store.get(CONTINUE)
            if current.checkpoint == "done":
                break
            changed_process = any(
                item["name"] == "PLATFORM_RELEASE_REQUEST_ID"
                and item.get("value") == CONTINUE
                for item in self.resource_state[("Deployment", "platform-runtime")][
                    "spec"
                ]["template"]["spec"]["containers"][0]["env"]
            )
            if (
                current.checkpoint == "install_self"
                and changed_process
                and self.controller.process_request_id != CONTINUE
            ):
                self.controller = self.make_controller(process_request_id=CONTINUE)
            self.controller.step()
        self.assertEqual(self.store.get(CONTINUE).phase, "ready")
        self.assertEqual(repaired.source_release, "releases/" + IDENTITY)
        self.assertEqual(
            [item.image_digest for item in repaired.targets],
            [item.image_digest for item in TARGETS],
        )
        self.assertEqual(self.controller.plan(fresh=True).state, "clean")
        expected = self.controller.renderer.render(
            repaired.targets, CONTINUE, gate_key="release-" + CONTINUE
        )
        for item in expected:
            if item["kind"] == "Deployment":
                actual = self.resource_state[(item["kind"], item["metadata"]["name"])]
                self.assertEqual(actual["spec"]["template"], item["spec"]["template"])
        self.assertFalse(
            any(
                key[0] in {"Secret", "PersistentVolumeClaim"}
                for _, key, *_ in self.requests
            )
        )
        self.assertEqual(self.admission.state, "active")
        self.assertFalse(
            self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"]
        )
        self.requests.clear()
        self.controller.reconcile(self.request(REQUEST))
        self.assertEqual(self.mutations(), [])

    def test_stale_plan_and_concurrent_acceptance_cannot_apply_old_manifest(self):
        old = self.request()
        self.drift_templates()
        with self.assertRaises(RpcError) as stale:
            self.controller.reconcile(old)
        self.assertEqual(stale.exception.code, "ABORTED")
        first = self.request()
        self.controller.reconcile(first)
        with self.assertRaises(RpcError):
            self.controller.reconcile(replace(first, request_id=REQUEST))
        self.assertEqual(self.store.latest().identity, CONTINUE)
        self.assertEqual(self.mutations(), [])

    def test_user_pause_preserves_manifests_and_blocks_new_repair(self):
        self.drift_templates()
        self.admission.state = "frozen"
        before = deepcopy(self.resource_state)
        plan = self.controller.plan(fresh=True)
        self.assertEqual(
            (plan.state, plan.reason_code), ("manual_required", "BUSINESS_PAUSED")
        )
        with self.assertRaises(RpcError):
            self.controller.reconcile(
                api.ReconcileReleaseRequest(
                    name=plan.base_release,
                    etag=plan.base_etag,
                    fingerprint="f" * 64,
                    request_id=CONTINUE,
                )
            )
        self.assertEqual(self.resource_state, before)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.admission.state, "frozen")


if __name__ == "__main__":
    unittest.main()
