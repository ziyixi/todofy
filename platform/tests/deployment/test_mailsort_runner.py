"""Three fixed release targets, safe template evidence and legacy ledger compatibility."""

import unittest
from copy import deepcopy
from dataclasses import replace
from unittest.mock import Mock

from personal_cloud.deployment.controller import Controller
from personal_cloud.deployment.resources import Renderer
from personal_cloud.status_daemon.config import Workload
from personal_cloud.status_daemon.cronjob import cronjob
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api

from .test_release import AT, CONFIG, IDENTITY, REQUEST, SHA, TARGETS, Fixture, asset

RUNNER = Workload(
    "mailsort-runner",
    "mailsort-runner",
    "mailsort-runner",
    "mailsort-runner-release",
    "mailsort-runner",
)
PROFILE = replace(CONFIG, workloads=(RUNNER, *CONFIG.workloads))
TARGET = pb.ReleaseTarget(
    workload_key=RUNNER.key,
    source_sha=SHA,
    image_digest="sha256:" + "d" * 64,
    request_id=REQUEST,
)


def resources():
    return Renderer(PROFILE, asset=asset()).render((*TARGETS, TARGET), IDENTITY)


def observation(items=None):
    selected = {
        item["metadata"]["name"]: deepcopy(item) for item in (items or resources())
    }
    job, target = selected["mailsort-runner"], selected["mailsort-runner-release"]
    job["metadata"]["generation"] = 4
    target["data"]["phase"] = "activated"
    return job, target


class TemplateEvidence(unittest.TestCase):
    def test_template_release_does_not_claim_a_running_job(self):
        job, target = observation()
        result = cronjob(RUNNER, target, job, AT)
        self.assertEqual(result.process_state, "stopped")
        self.assertEqual(result.release.observation_scope, "template")
        self.assertEqual(result.release.state, "ready")
        self.assertEqual(result.release.actual, replace(TARGET, generation=4))
        self.assertIsNone(result.active_count)
        self.assertEqual(result.health_state, "unsupported")

    def test_desired_identity_cannot_fill_missing_or_changed_template_evidence(self):
        for changed in ("image", "source", "suspend", "policy"):
            with self.subTest(changed=changed):
                job, target = observation()
                pod = job["spec"]["jobTemplate"]["spec"]["template"]
                if changed == "image":
                    pod["spec"]["containers"][0]["image"] = "mutable:latest"
                elif changed == "source":
                    pod["metadata"]["annotations"]["personal-cloud/source-sha"] = (
                        "b" * 40
                    )
                elif changed == "suspend":
                    job["spec"]["suspend"] = True
                else:
                    job["spec"]["concurrencyPolicy"] = "Allow"
                result = cronjob(RUNNER, target, job, AT)
                self.assertNotEqual(result.release.state, "ready")
        self.assertEqual(cronjob(RUNNER, None, None, AT).release.state, "missing")

    def test_renderer_keeps_auth_and_machine_token_out_of_daemon(self):
        job, _ = observation()
        spec = job["spec"]
        self.assertEqual(spec["schedule"], "0 * * * *")
        self.assertEqual(spec["concurrencyPolicy"], "Forbid")
        self.assertEqual(spec["jobTemplate"]["spec"]["backoffLimit"], 0)
        self.assertEqual(spec["jobTemplate"]["spec"]["activeDeadlineSeconds"], 900)
        pod = spec["jobTemplate"]["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 10001)
        self.assertEqual(
            pod["containers"][0]["command"], ["python", "-m", "mailsort_runner"]
        )
        self.assertEqual(
            pod["volumes"][0]["persistentVolumeClaim"]["claimName"],
            "mailsort-runner-auth",
        )
        self.assertFalse(
            any(
                item["kind"] in {"Secret", "PersistentVolumeClaim"}
                for item in resources()
            )
        )

    def test_old_two_target_release_does_not_invent_a_runner_target(self):
        selected = Renderer(PROFILE, asset=asset()).render(TARGETS, IDENTITY)
        self.assertEqual(len(selected), 10)
        self.assertFalse(
            any(
                item["metadata"]["name"].startswith("mailsort-runner")
                for item in selected
            )
        )


class ThreeTargetRelease(Fixture, unittest.TestCase):
    def setUp(self):
        self.initialize()
        self.controller = Controller(
            PROFILE,
            self.store,
            self.kube,
            self.admission,
            Renderer(PROFILE, asset=asset()),
            self.reads,
            source_sha=lambda: SHA,
            process_request_id=REQUEST,
            clock=lambda: self.at,
        )
        patch = self.kube.patch

        def merge_patch(kind, name, change):
            previous = deepcopy(
                self.resource_state.get((kind, name), {}).get("data", {})
            )
            patch(kind, name, change)
            if kind == "ConfigMap":
                self.resource_state[(kind, name)]["data"] = {
                    **previous,
                    **change.get("data", {}),
                }

        self.kube.patch = merge_patch
        original = self.reads.snapshot

        def snapshot():
            node = original()
            job = deepcopy(self.resource_state.get(("CronJob", "mailsort-runner")))
            if job:
                job["metadata"]["generation"] = 4
            target = self.resource_state.get(("ConfigMap", "mailsort-runner-release"))
            return replace(
                node, workloads=(cronjob(RUNNER, target, job, self.at), *node.workloads)
            )

        self.reads.snapshot = snapshot

    def test_controller_finishes_three_targets_without_creating_any_job(self):
        self.controller.create(
            api.CreateReleaseRequest(
                release_id=IDENTITY,
                request_id=REQUEST,
                release=pb.Release(targets=(*TARGETS, TARGET)),
            )
        )
        self.until("done")
        final = self.controller.release(self.store.get(IDENTITY))
        self.assertEqual(final.phase, "ready")
        self.assertEqual(len(final.observed_workloads), 3)
        self.assertFalse(
            any(event[0] == "apply" and event[1] == "Job" for event in self.events)
        )

    def test_template_drift_is_repairable_and_clean_reconcile_is_a_noop(self):
        self.controller.create(
            api.CreateReleaseRequest(
                release_id=IDENTITY,
                request_id=REQUEST,
                release=pb.Release(targets=(*TARGETS, TARGET)),
            )
        )
        self.until("done")
        self.resource_state = {
            (item["kind"], item["metadata"]["name"]): deepcopy(item)
            for item in resources()
        }
        self.resource_state[("CronJob", "newsletter-daily")]["spec"]["suspend"] = False
        self.kube.get = Mock(
            side_effect=lambda kind, name, **_: deepcopy(
                self.resource_state[(kind, name)]
            )
        )
        self.kube.dry_run = Mock(side_effect=lambda item, **_: deepcopy(item))
        call = self.admission.call
        self.admission.call = lambda action, key, **_: call(action, key)
        plan = self.controller.plan(fresh=True)
        self.assertEqual(plan.state, "clean")
        before = len(self.events)
        self.controller.reconcile(
            api.ReconcileReleaseRequest(
                name=plan.base_release,
                etag=plan.base_etag,
                fingerprint=plan.fingerprint,
                request_id="f219c057-fc33-4d8b-8819-d7a1f776b35f",
            )
        )
        self.assertFalse(self.controller.step())
        self.assertTrue(all(event[0] != "apply" for event in self.events[before:]))
        self.resource_state[("CronJob", "mailsort-runner")]["spec"]["schedule"] = (
            "*/5 * * * *"
        )
        plan = self.controller.plan(fresh=True)
        self.assertEqual(plan.state, "repairable")
        self.assertEqual(
            [change.resource_key for change in plan.template_changes],
            ["mailsort-runner"],
        )
