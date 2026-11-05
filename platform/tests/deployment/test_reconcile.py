"""Ready-release drift, separate repair identities and owner pause boundaries."""

import json
import threading
import unittest
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from personal_cloud.deployment.kubernetes import Client, DependencyUnavailable
from personal_cloud.deployment.reconcile import RESOURCE_KEYS
from personal_cloud.deployment.router import Router
from personal_cloud.deployment.store import Store
from urllib3.response import HTTPResponse
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import field_rules, to_wire

from .fixtures import (
    CONFIG,
    CONTINUE,
    IDENTITY,
    REQUEST,
    SHA,
    STAMP,
    TARGETS,
    Fixture,
)

SECOND = "458521e1-5850-4a55-8b84-867ec5c41463"
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


class RuntimeResourceContract(unittest.TestCase):
    def test_every_fixed_resource_fits_the_reconcile_plan_contract(self):
        changes = tuple(
            pb.ReconcileChange(
                resource_key=alias,
                action="update",
                reason_code="RUNTIME_FIELDS_CHANGED",
            )
            for alias in sorted(RESOURCE_KEYS.values())
        )
        self.assertGreaterEqual(
            field_rules(pb.ReconcilePlan, "changes").max_items, len(changes)
        )
        for change in changes:
            with self.subTest(resource_key=change.resource_key):
                self.assertEqual(to_wire(change)["resource_key"], change.resource_key)
        plan = pb.ReconcilePlan(
            name="reconcilePlan",
            state="repairable",
            observed_at=STAMP,
            changes=changes,
        )
        self.assertEqual(len(to_wire(plan)["changes"]), len(RESOURCE_KEYS))


class RuntimeRepair(Fixture, unittest.TestCase):
    def setUp(self):
        self.initialize()
        self.create()
        self.until("done")
        source = self.store.get(IDENTITY)
        self.resource_state = {
            (item["kind"], item["metadata"]["name"]): deepcopy(item)
            for item in self.controller.renderer.render(
                self.controller.release(source).targets, IDENTITY
            )
        }
        self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"] = False
        self.kube.get = Mock(side_effect=self.get)
        self.kube.dry_run = Mock(side_effect=lambda item, **_: deepcopy(item))
        self.gates = []
        admission_call = self.admission.call

        def call(action, key, **_):
            self.gates.append((action, key))
            return admission_call(action, key)

        self.admission.call = call
        self.events.clear()

    def get(self, kind, name, **_):
        if (kind, name) not in self.resource_state:
            raise DependencyUnavailable(missing=True)
        return deepcopy(self.resource_state[(kind, name)])

    def request(self, identity=CONTINUE):
        plan = self.controller.plan(fresh=True)
        return api.ReconcileReleaseRequest(
            name=plan.base_release,
            etag=plan.base_etag,
            fingerprint=plan.fingerprint,
            request_id=identity,
        )

    def drift(self):
        self.resource_state[("Deployment", "newsletter-config-sync")]["spec"][
            "replicas"
        ] = 0

    def test_clean_plan_and_replayed_noop_never_patch_or_restart(self):
        self.resource_state[("Deployment", "newsletter")]["status"] = {
            "observedGeneration": 71
        }
        request = self.request()
        self.assertEqual(self.controller.plan().state, "clean")
        result = self.controller.reconcile(request)
        self.assertEqual(result.name, "releases/" + IDENTITY)
        self.assertEqual(self.controller.reconcile(request), result)
        self.assertFalse(self.controller.step())
        self.assertTrue(all(event[0] == "admission" for event in self.events))
        self.assertEqual(len(self.kube.dry_run.call_args_list), 20)

    def test_repair_persists_new_identity_frozen_targets_and_distinct_drain(self):
        self.drift()
        request = self.request()
        result = self.controller.reconcile(request)
        self.assertEqual(
            (result.name, result.source_release, result.phase),
            ("releases/" + CONTINUE, "releases/" + IDENTITY, "accepted"),
        )
        self.assertTrue(
            all(
                target.request_id == CONTINUE and target.source_sha == SHA
                for target in result.targets
            )
        )
        durable = Store(Path(self.directory.name) / "ledger.sqlite3").get(CONTINUE)
        self.assertEqual(durable.gate_key, "release-" + CONTINUE)
        self.assertEqual(self.controller.reconcile(request), result)
        self.assertTrue(self.controller.step())
        self.assertTrue(self.controller.step())
        self.assertIn(("begin", "release-" + CONTINUE), self.gates)
        self.assertNotIn(("begin", "release-" + SHA), self.gates)
        self.assertTrue(
            all(event[0] != "apply" or event[1] == "Service" for event in self.events)
        )

    def test_replayed_identity_rejects_changed_input(self):
        self.drift()
        request = self.request()
        self.controller.reconcile(request)
        with self.assertRaises(RpcError) as error:
            self.controller.reconcile(replace(request, fingerprint="f" * 64))
        self.assertEqual(error.exception.reason, "RECONCILE_CONFLICT")

    def test_plan_change_and_inflight_release_block_effects(self):
        request = self.request()
        self.drift()
        with self.assertRaises(RpcError) as error:
            self.controller.reconcile(request)
        self.assertEqual(error.exception.code, "ABORTED")
        self.assertEqual(self.store.latest().identity, IDENTITY)
        self.assertTrue(all(event[0] == "admission" for event in self.events))
        self.controller.reconcile(self.request())
        self.assertEqual(
            self.controller.plan(fresh=True).reason_code, "RELEASE_IN_PROGRESS"
        )
        with self.assertRaises(RpcError) as error:
            self.controller.reconcile(replace(request, request_id=SECOND))
        self.assertEqual(error.exception.reason, "RECONCILE_MANUAL_REQUIRED")

    def test_manual_admission_and_scheduler_pauses_remain_unchanged(self):
        self.drift()
        for kind in ("admission", "scheduler"):
            with self.subTest(kind=kind):
                self.admission.state = "frozen" if kind == "admission" else "active"
                self.resource_state[("CronJob", "newsletter-daily")]["spec"][
                    "suspend"
                ] = kind == "scheduler"
                plan = self.controller.plan(fresh=True)
                self.assertEqual(
                    (plan.state, plan.reason_code),
                    ("manual_required", "BUSINESS_PAUSED"),
                )
                self.assertIsNone(plan.fingerprint)
        self.assertEqual(self.store.latest().identity, IDENTITY)
        self.assertTrue(all(event[0] == "admission" for event in self.events))

    def test_pause_after_acceptance_is_held_before_any_runtime_write(self):
        self.drift()
        result = self.controller.reconcile(self.request())
        self.admission.state = "frozen"
        self.assertFalse(self.controller.step())
        current = self.store.get(result.name.split("/")[1])
        self.assertEqual(
            (current.phase, current.error_code), ("held", "RECONCILE_MANUAL_REQUIRED")
        )
        self.assertTrue(all(event[0] == "admission" for event in self.events))

    def test_missing_schedule_restored_suspended_before_begin(self):
        del self.resource_state[("CronJob", "newsletter-daily")]
        patch_fn = self.kube.patch

        def missing(kind, name, body):
            if (kind, name) not in self.resource_state:
                raise DependencyUnavailable(missing=True)
            return patch_fn(kind, name, body)

        self.kube.patch = missing
        plan = self.controller.plan(fresh=True)
        self.assertEqual(
            [(x.resource_key, x.action) for x in plan.changes],
            [("newsletter-daily", "create")],
        )
        self.controller.reconcile(self.request())
        self.assertTrue(self.controller.step())
        self.assertTrue(
            self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"]
        )
        self.assertFalse(any(action == "begin" for action, _ in self.gates))

    def test_ownership_conflicts_unavailable_and_wrong_baked_source_are_manual(self):
        self.kube.dry_run.side_effect = DependencyUnavailable(conflict=True)
        plan = self.controller.plan(fresh=True)
        self.assertEqual((plan.state, len(plan.changes)), ("manual_required", 10))
        self.assertTrue(all(item.action == "conflict" for item in plan.changes))
        self.kube.dry_run.side_effect = DependencyUnavailable()
        self.assertEqual(self.controller.plan(fresh=True).state, "unavailable")
        self.controller.planner.source_sha = lambda: "e" * 40
        self.assertEqual(
            self.controller.plan(fresh=True).reason_code, "RUNTIME_SOURCE_MISMATCH"
        )

    def test_store_cas_allows_only_one_new_operation(self):
        self.drift()
        request = to_wire(self.request())
        source = self.store.latest()
        barrier, results = threading.Barrier(2), []

        def compete(identity):
            value = {**request, "request_id": identity}
            body = {
                "request_id": identity,
                "targets": [
                    {**item, "request_id": identity} for item in source.body["targets"]
                ],
            }
            barrier.wait()
            try:
                results.append(self.store.reconcile(value, body).identity)
            except RpcError as error:
                results.append(error.code)

        threads = [
            threading.Thread(target=compete, args=(identity,))
            for identity in (CONTINUE, SECOND)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(len(results), 2)
        self.assertEqual(results.count("ABORTED"), 1)

    def test_second_ready_repair_uses_another_durable_operation(self):
        self.drift()
        first = self.controller.reconcile(self.request())
        self.store.checkpoint(CONTINUE, "ready", "done")
        first_record = self.store.get(CONTINUE)
        self.resource_state = {
            (x["kind"], x["metadata"]["name"]): deepcopy(x)
            for x in self.controller.renderer.render(
                first.targets, CONTINUE, gate_key=first_record.gate_key
            )
        }
        self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"] = False
        self.drift()
        second = self.controller.reconcile(self.request(SECOND))
        self.assertEqual(second.source_release, first.name)
        self.assertNotEqual(self.store.get(SECOND).gate_key, first_record.gate_key)
        self.assertEqual(second.targets[0].image_digest, first.targets[0].image_digest)
        self.assertTrue(self.controller.step())
        self.assertTrue(self.controller.step())
        self.assertIn(("begin", "release-" + SECOND), self.gates)

    def test_plan_has_no_manifests_or_private_fields(self):
        self.drift()
        wire = to_wire(self.controller.plan(fresh=True))
        self.assertEqual(
            set(wire),
            {
                "name",
                "base_release",
                "base_etag",
                "state",
                "fingerprint",
                "observed_at",
                "changes",
            },
        )
        self.assertEqual(
            set(wire["changes"][0]), {"resource_key", "action", "reason_code"}
        )
        self.assertNotIn(CONFIG.repository, json.dumps(wire))
        self.assertNotIn(REQUEST, json.dumps(wire))

    def test_router_reconcile_routes_and_background_worker_lifecycle(self):
        self.drift()
        router = Router(self.controller, "synthetic-release-token")
        headers = {"Authorization": "Bearer synthetic-release-token"}
        status, plan = router.handle(
            "GET", "/api/v1/reconcilePlan", headers, lambda: None
        )
        self.assertEqual((status, plan["state"]), (200, "repairable"))
        self.assertEqual(to_wire(router.plan()), plan)
        status, repaired = router.handle(
            "POST",
            f"/api/v1/{plan['base_release']}:reconcile",
            headers,
            lambda: {
                "etag": plan["base_etag"],
                "fingerprint": plan["fingerprint"],
                "request_id": CONTINUE,
            },
        )
        self.assertEqual((status, repaired["name"]), (200, "releases/" + CONTINUE))
        self.controller.start()
        self.addCleanup(router.close)
        with self.assertRaises(RuntimeError):
            self.controller.start()
        for _ in range(50):
            if self.store.get(CONTINUE).checkpoint != "suspend":
                break
            self.controller.wake.set()
        self.assertNotEqual(self.store.get(CONTINUE).checkpoint, "suspend")
        router.close()


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


if __name__ == "__main__":
    unittest.main()
