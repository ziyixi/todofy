"""Ready-release drift, separate repair identities and owner pause boundaries."""

import json
import threading
import unittest
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

from personal_cloud.deployment.kubernetes import DependencyUnavailable
from personal_cloud.deployment.store import Store
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import to_wire

from .test_release import CONFIG, CONTINUE, IDENTITY, REQUEST, SHA, Fixture

SECOND = "458521e1-5850-4a55-8b84-867ec5c41463"


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
        patch = self.kube.patch

        def missing(kind, name, body):
            if (kind, name) not in self.resource_state:
                raise DependencyUnavailable(missing=True)
            return patch(kind, name, body)

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
