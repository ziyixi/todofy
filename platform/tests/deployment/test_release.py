"""No sockets, cluster, production resources or business side effects."""

import json
import tempfile
import threading
import unittest
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import yaml
from personal_cloud.deployment.admission import (
    AdmissionBusy,
    AdmissionConflict,
    AdmissionUnavailable,
)
from personal_cloud.deployment.admission import Client as Admission
from personal_cloud.deployment.controller import Controller
from personal_cloud.deployment.kubernetes import DependencyUnavailable
from personal_cloud.deployment.resources import Renderer, image
from personal_cloud.deployment.router import Router
from personal_cloud.deployment.store import Store
from personal_cloud.status_daemon.config import Configuration, Workload
from personal_cloud.status_daemon.server import Cache, Service, create_app
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.platform.runtime.v1 import runtime_service_pb as api
from ziyixi_proto.rpc_status import RpcError
from ziyixi_proto.wire_json import from_wire, to_wire

AT = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)
STAMP = "2026-10-02T12:00:00Z"
SHA = "a" * 40
REQUEST = "89f6feb1-4287-4f22-a374-76b9e9c2b1c0"
IDENTITY = "afc6aa50-5a15-461d-b93c-dbd9115ccacb"
CONTINUE = "f219c057-fc33-4d8b-8819-d7a1f776b35f"
CONFIG = Configuration(
    "vps",
    "personal-cloud",
    (
        Workload(
            "newsletter", "newsletter", "newsletter", "newsletter-release", "newsletter"
        ),
        Workload(
            "platform-runtime",
            "platform-runtime",
            "platform-runtime",
            "platform-release",
            "personal-cloud",
        ),
    ),
    "example/project",
)
TARGETS = (
    pb.ReleaseTarget(
        workload_key="newsletter",
        source_sha=SHA,
        image_digest="sha256:" + "b" * 64,
        request_id=REQUEST,
    ),
    pb.ReleaseTarget(
        workload_key="platform-runtime",
        source_sha=SHA,
        image_digest="sha256:" + "c" * 64,
        request_id=REQUEST,
    ),
)


def asset():
    directory = Path(__file__).resolve().parents[2] / "k3s/newsletter"
    names = yaml.safe_load((directory / "kustomization.yaml").read_text())["resources"]
    return {
        "apiVersion": "v1",
        "kind": "List",
        "items": [
            item
            for name in names
            for item in yaml.safe_load_all((directory / name).read_text())
        ],
    }


def counts(names):
    return {name: 0 for name in names}


def drain(state="active", key=None):
    return {
        "version": 1,
        "state": state,
        "request_key": key,
        "busy": False,
        "inflight": counts(
            (
                "activities",
                "editions",
                "packets",
                "workflow_attempts",
                "notion_entities",
                "notion_versions",
                "delivery",
            )
        ),
        "unknown": counts(
            (
                "interrupted_activities",
                "packets",
                "workflow_attempts",
                "notion_entities",
                "notion_versions",
                "delivery",
            )
        ),
        "queued": counts(("editions", "collection_runs")),
    }


class Fixture:
    def initialize(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.at = AT
        self.events = []
        self.store = Store(Path(self.directory.name) / "ledger.sqlite3")
        self.resource_state = {}
        owner = self

        class Kube:
            fail = False
            replace_process = False

            def patch(inner, kind, name, change):
                if inner.fail:
                    raise DependencyUnavailable()
                owner.events.append(("patch", kind, name, deepcopy(change)))
                owner.resource_state.setdefault((kind, name), {}).update(
                    deepcopy(change)
                )

            def apply(inner, item):
                if inner.fail:
                    raise DependencyUnavailable()
                name, kind = item["metadata"]["name"], item["kind"]
                owner.events.append(("apply", kind, name, deepcopy(item)))
                owner.resource_state[(kind, name)] = deepcopy(item)
                if inner.replace_process and (kind, name) == (
                    "Deployment",
                    "platform-runtime",
                ):
                    raise SystemExit("synthetic-recreate")

            def close(inner):
                pass

        class Admission:
            state, unknown, busy = "active", False, False

            def call(inner, action, key):
                owner.events.append(("admission", action))
                if action == "begin":
                    inner.state = "draining"
                if action == "freeze":
                    if inner.busy:
                        raise AdmissionBusy("RELEASE_HELD")
                    inner.state = "frozen"
                if action == "resume":
                    inner.state = "active"
                    value = drain("resumed", key)
                else:
                    value = drain(inner.state, key if inner.state != "active" else None)
                value["unknown"]["packets"] = int(inner.unknown)
                value["inflight"]["activities"] = int(inner.busy)
                value["busy"] = inner.busy
                return value

            def close(inner):
                pass

        self.kube, self.admission = Kube(), Admission()
        self.generation = 3
        self.bad_digest = False
        self.health = "healthy"
        self.reads = SimpleNamespace(
            cache=SimpleNamespace(invalidate=Mock()), snapshot=self.snapshot
        )
        self.controller = self.make_controller()

    def make_controller(self, **options):
        return Controller(
            CONFIG,
            self.store,
            self.kube,
            self.admission,
            Renderer(CONFIG, asset=options.pop("asset", asset())),
            self.reads,
            source_sha=options.pop("source_sha", lambda: SHA),
            process_request_id=options.pop("process_request_id", REQUEST),
            clock=lambda: self.at,
            **options,
        )

    def snapshot(self):
        values = []
        for target in TARGETS:
            newsletter = target.workload_key == "newsletter"
            actual = pb.ReleaseTarget(
                workload_key=target.workload_key,
                source_sha=SHA,
                image_digest="sha256:" + "f" * 64
                if self.bad_digest
                else target.image_digest,
                request_id=REQUEST,
                generation=self.generation,
            )
            active = self.admission.state == "active"
            values.append(
                pb.WorkloadStatus(
                    name="workloads/" + target.workload_key,
                    workload_key=target.workload_key,
                    process_state="running",
                    admission_state=("accepting" if active else "frozen")
                    if newsletter
                    else "unsupported",
                    health_state=self.health if newsletter else "unsupported",
                    unknown_count=int(self.admission.unknown) if newsletter else None,
                    observed_at=self.at.isoformat().replace("+00:00", "Z"),
                    release=pb.ReleaseStatus(
                        state="ready" if active else "pending",
                        desired=target,
                        actual=actual,
                        observed_generation=self.generation,
                        observed_at=self.at.isoformat().replace("+00:00", "Z"),
                    ),
                )
            )
        return pb.NodeStatus(
            name="nodeStatus",
            node_key="vps",
            state="degraded" if self.health == "degraded" else "ready",
            observed_at=self.at.isoformat().replace("+00:00", "Z"),
            workloads=tuple(values),
        )

    def create(self, **changes):
        request = api.CreateReleaseRequest(
            release_id=IDENTITY, request_id=REQUEST, release=pb.Release(targets=TARGETS)
        )
        return self.controller.create(
            request
            if not changes
            else api.CreateReleaseRequest(**{**request.__dict__, **changes})
        )

    def until(self, checkpoint):
        for _ in range(25):
            if self.store.get(IDENTITY).checkpoint == checkpoint:
                return
            self.assertTrue(self.controller.step(), self.store.get(IDENTITY))
        self.fail("Checkpoint did not converge")


class Reconciliation(Fixture, unittest.TestCase):
    def setUp(self):
        self.clock = patch("personal_cloud.deployment.store.now", return_value=STAMP)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.initialize()

    def test_frozen_immutable_requests_verified_rollout_and_admission_order(self):
        release = self.create()
        self.assertEqual(release.phase, "accepted")
        self.until("done")
        final = self.store.get(IDENTITY)
        self.assertEqual((final.phase, len(final.observed)), ("ready", 2))
        self.assertEqual(self.controller.release(final).targets, TARGETS)
        self.assertFalse((Path(self.directory.name) / "bin").exists())
        suspend = next(
            index
            for index, event in enumerate(self.events)
            if event[:3] == ("patch", "CronJob", "newsletter-daily")
        )
        frozen = self.events.index(("admission", "freeze"))
        first_apply = next(
            index for index, event in enumerate(self.events) if event[0] == "apply"
        )
        resumed = self.events.index(("admission", "resume"))
        unsuspend = next(
            index
            for index, event in enumerate(self.events)
            if event[:3] == ("patch", "CronJob", "newsletter-daily")
            and event[3] == {"spec": {"suspend": False}}
        )
        self.assertLess(suspend, frozen)
        self.assertLess(frozen, first_apply)
        self.assertLess(first_apply, resumed)
        self.assertLess(resumed, unsuspend)
        self.assertEqual(
            {event[2] for event in self.events if event[:2] == ("patch", "CronJob")},
            {"newsletter-daily"},
        )
        observer = self.resource_state[("CronJob", "platform-observer")]
        self.assertFalse(observer["spec"]["suspend"])
        self.assertFalse(self.controller.step())
        from_wire(pb.Release, to_wire(self.controller.release(final)), strict=True)

    def test_quiescent_historical_unknown_is_preserved_through_verified_release(self):
        self.admission.unknown = 32
        self.health = "degraded"
        self.create()
        self.until("done")
        final = self.controller.release(self.store.get(IDENTITY))
        newsletter = next(
            value
            for value in final.observed_workloads
            if value.workload_key == "newsletter"
        )
        self.assertEqual(final.phase, "ready")
        self.assertEqual(self.admission.unknown, 32)
        self.assertEqual(newsletter.unknown_count, 32)
        self.assertEqual(newsletter.health_state, "degraded")
        self.assertEqual(newsletter.admission_state, "accepting")
        self.assertEqual(newsletter.release.actual.source_sha, SHA)
        self.assertEqual(
            newsletter.release.actual.image_digest, TARGETS[0].image_digest
        )
        self.assertEqual(newsletter.release.actual.request_id, REQUEST)
        self.assertEqual(newsletter.release.actual.generation, self.generation)
        self.assertEqual(
            [event[1] for event in self.events if event[0] == "admission"],
            ["begin", "status", "freeze", "resume"],
        )

    def test_applying_status_follows_each_manifest_before_verification(self):
        self.create()
        self.until("verify")
        for name in ("newsletter-release", "platform-release"):
            manifest = next(
                index
                for index, event in enumerate(self.events)
                if event[:3] == ("apply", "ConfigMap", name)
            )
            self.assertNotIn("phase", self.events[manifest][3]["data"])
            self.assertEqual(
                self.events[manifest + 1],
                ("patch", "ConfigMap", name, {"data": {"phase": "applying"}}),
            )
        self.assertNotIn(("admission", "resume"), self.events)

    def test_historical_unknown_does_not_allow_busy_drain_to_apply(self):
        self.admission.unknown = 32
        self.admission.busy = True
        self.health = "degraded"
        self.create()
        self.until("drain")
        self.assertFalse(self.controller.step())
        self.assertEqual(self.store.get(IDENTITY).phase, "draining")
        self.at += timedelta(seconds=601)
        self.assertFalse(self.controller.step())
        self.assertEqual(self.store.get(IDENTITY).phase, "held")
        self.assertFalse(
            any(
                event[0] == "apply" or event == ("admission", "freeze")
                for event in self.events
            )
        )
        self.assertEqual(self.admission.state, "draining")

    def test_first_release_apply_keeps_persistent_paths_from_the_canonical_manifest(
        self,
    ):
        self.create()
        self.until("verify")
        deployment = self.resource_state[("Deployment", "newsletter")]
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item.get("value") for item in container["env"]}
        expected = {
            "NEWSLETTER_DATA_DIR": "/var/lib/newsletter",
            "CODEX_HOME": "/var/lib/newsletter-auth",
            "NEWSLETTER_CODEX_HOME": "/var/lib/newsletter-auth",
            "NEWSLETTER_CONTENT_CONFIG_DIR": "/var/lib/newsletter-config",
        }
        self.assertEqual({key: env.get(key) for key in expected}, expected)
        self.assertEqual(env["NEWSLETTER_BOOTSTRAP_DRAIN_KEY"], "release-" + SHA)
        self.assertEqual(env["NEWSLETTER_RELEASE_REQUEST_ID"], REQUEST)
        self.assertNotIn(("admission", "resume"), self.events)

    def test_work_becoming_busy_before_freeze_holds_without_any_image_apply(self):
        self.admission.unknown = 32
        self.health = "degraded"
        self.create()
        self.until("freeze")
        self.admission.busy = True
        self.assertFalse(self.controller.step())
        self.assertEqual(self.store.get(IDENTITY).phase, "frozen")
        self.at += timedelta(seconds=601)
        self.assertFalse(self.controller.step())
        self.assertEqual(
            (self.store.get(IDENTITY).phase, self.store.get(IDENTITY).checkpoint),
            ("held", "freeze"),
        )
        self.assertEqual(self.admission.state, "draining")
        self.assertNotIn(("admission", "resume"), self.events)
        self.assertFalse(any(event[0] == "apply" for event in self.events))

    def test_freeze_refusal_with_historical_unknown_holds_before_image_apply(self):
        for refusal in (AdmissionConflict, AdmissionUnavailable):
            with self.subTest(refusal=refusal):
                self.initialize()
                self.admission.unknown = 32
                self.health = "degraded"
                self.create()
                self.until("freeze")
                self.admission.call = Mock(side_effect=refusal("RELEASE_HELD"))
                self.assertFalse(self.controller.step())
                self.admission.call.assert_called_once_with("freeze", "release-" + SHA)
                self.assertEqual(self.store.get(IDENTITY).phase, "held")
                self.assertEqual(self.admission.state, "draining")
                self.assertNotIn(("admission", "resume"), self.events)
                self.assertFalse(any(event[0] == "apply" for event in self.events))

    def test_observed_generation_and_actual_digest_are_required_before_resume(self):
        for malformed in ("generation", "digest"):
            with self.subTest(malformed=malformed):
                self.initialize()
                self.admission.unknown = 32
                self.health = "degraded"
                self.create()
                self.until("verify")
                if malformed == "generation":
                    self.generation = None
                else:
                    self.bad_digest = True
                self.assertFalse(self.controller.step())
                self.assertNotIn(("admission", "resume"), self.events)
                self.at += timedelta(seconds=601)
                self.assertFalse(self.controller.step())
                self.assertEqual(self.store.get(IDENTITY).phase, "held")
                self.assertEqual(self.admission.state, "frozen")

    def test_caller_generation_is_rejected_and_degraded_process_does_not_activate(self):
        altered = pb.ReleaseTarget(
            workload_key="newsletter",
            source_sha=SHA,
            image_digest=TARGETS[0].image_digest,
            request_id=REQUEST,
            generation=3,
        )
        with self.assertRaises(RpcError) as error:
            self.controller.create(
                api.CreateReleaseRequest(
                    release_id=IDENTITY,
                    request_id=REQUEST,
                    release=pb.Release(targets=(altered, TARGETS[1])),
                )
            )
        self.assertEqual(error.exception.code, "INVALID_ARGUMENT")
        self.assertIsNone(self.store.latest())
        self.create()
        self.until("verify")
        self.health = "degraded"
        self.assertFalse(self.controller.step())
        self.assertNotIn(("admission", "resume"), self.events)
        self.assertEqual(self.store.get(IDENTITY).checkpoint, "verify")

    def test_historical_unknown_does_not_relax_actual_identity_or_other_workload_health(
        self,
    ):
        for malformed in (
            "missing_actual",
            "source_sha",
            "request_id",
            "stale",
            "process",
            "admission",
            "other_workload_health",
        ):
            with self.subTest(malformed=malformed):
                self.initialize()
                self.admission.unknown = 32
                self.health = "degraded"
                self.create()
                self.until("verify")
                snapshot = self.snapshot()
                newsletter, platform = snapshot.workloads
                if malformed == "missing_actual":
                    newsletter = replace(
                        newsletter, release=replace(newsletter.release, actual=None)
                    )
                elif malformed in {"source_sha", "request_id"}:
                    actual = replace(
                        newsletter.release.actual,
                        **{
                            malformed: "f" * 40
                            if malformed == "source_sha"
                            else CONTINUE
                        },
                    )
                    newsletter = replace(
                        newsletter, release=replace(newsletter.release, actual=actual)
                    )
                elif malformed == "stale":
                    newsletter = replace(
                        newsletter,
                        observed_at=(self.at - timedelta(seconds=61))
                        .isoformat()
                        .replace("+00:00", "Z"),
                    )
                elif malformed == "process":
                    newsletter = replace(newsletter, process_state="stopped")
                elif malformed == "admission":
                    newsletter = replace(newsletter, admission_state="accepting")
                else:
                    platform = replace(
                        platform, health_state="degraded", unknown_count=32
                    )
                self.reads.snapshot = Mock(
                    return_value=replace(snapshot, workloads=(newsletter, platform))
                )
                self.assertFalse(self.controller.step())
                self.assertEqual(self.store.get(IDENTITY).checkpoint, "verify")
                self.assertNotIn(("admission", "resume"), self.events)
                self.at += timedelta(seconds=601)
                self.assertFalse(self.controller.step())
                self.assertEqual(self.store.get(IDENTITY).phase, "held")
                self.assertEqual(self.admission.unknown, 32)

    def test_conflicting_observed_target_never_activates_or_resumes(self):
        self.create()
        self.until("verify")
        snapshot = self.snapshot()
        workload = snapshot.workloads[0]
        wrong = replace(workload.release.desired, request_id=CONTINUE)
        self.reads.snapshot = lambda: replace(
            snapshot,
            workloads=(
                replace(workload, release=replace(workload.release, desired=wrong)),
                snapshot.workloads[1],
            ),
        )
        self.assertFalse(self.controller.step())
        self.assertEqual(self.store.get(IDENTITY).checkpoint, "verify")
        self.assertNotIn(("admission", "resume"), self.events)
        self.assertFalse(
            any(
                event[:2] == ("patch", "ConfigMap")
                and event[3] == {"data": {"phase": "activated"}}
                for event in self.events
            )
        )

    def test_lost_resume_response_is_held_without_claiming_closed_admission(self):
        self.create()
        self.until("resume")
        original = self.admission.call

        def lost(action, key):
            value = original(action, key)
            if action == "resume":
                raise AdmissionUnavailable("UNAVAILABLE")
            return value

        self.admission.call = lost
        self.assertFalse(self.controller.step())
        record = self.store.get(IDENTITY)
        self.assertEqual((record.phase, record.checkpoint), ("held", "resume"))
        newsletter = next(
            value
            for value in self.controller.release(record).observed_workloads
            if value.workload_key == "newsletter"
        )
        self.assertEqual(newsletter.admission_state, "accepting")
        self.assertEqual(
            self.resource_state[("CronJob", "newsletter-daily")]["spec"],
            {"suspend": True},
        )
        self.store = Store(self.store.path)
        self.controller = self.make_controller()
        self.assertFalse(self.controller.step())
        self.admission.call = original
        self.controller.resume(
            api.ResumeReleaseRequest(
                name="releases/" + IDENTITY, request_id=CONTINUE, etag=record.etag
            )
        )
        self.until("done")
        self.assertEqual(self.events.count(("admission", "begin")), 1)
        self.assertEqual(self.events.count(("admission", "freeze")), 1)

    def test_rollout_failure_after_resume_reports_actual_admission_and_holds_new_cron(
        self,
    ):
        self.create()
        self.until("finish")
        self.bad_digest = True
        self.at += timedelta(seconds=601)
        self.assertFalse(self.controller.step())
        record = self.store.get(IDENTITY)
        self.assertEqual(record.phase, "held")
        newsletter = next(
            value
            for value in self.controller.release(record).observed_workloads
            if value.workload_key == "newsletter"
        )
        self.assertEqual(newsletter.admission_state, "accepting")
        self.assertEqual(
            self.resource_state[("CronJob", "newsletter-daily")]["spec"],
            {"suspend": True},
        )

    def test_self_recreate_checkpoint_is_recovered_using_the_new_baked_template(self):
        old = self.make_controller(
            source_sha=lambda: "d" * 40, process_request_id=CONTINUE
        )
        self.controller = old
        self.create()
        self.until("install_self")
        self.kube.replace_process = True
        with self.assertRaises(SystemExit):
            self.controller.step()
        self.assertEqual(
            (self.store.get(IDENTITY).phase, self.store.get(IDENTITY).checkpoint),
            ("applying", "install_self"),
        )
        self.assertEqual(
            [event[2] for event in self.events if event[0] == "apply"],
            ["platform-runtime"],
        )
        new_asset = asset()
        resource = next(
            item
            for item in new_asset["items"]
            if item["kind"] == "Deployment"
            and item["metadata"]["name"] == "newsletter-config-sync"
        )
        resource["spec"]["template"]["spec"]["containers"][0]["env"].append(
            {"name": "SYNTHETIC_NEW_TEMPLATE", "value": "new"}
        )
        self.kube.replace_process = False
        self.store = Store(self.store.path)
        self.controller = self.make_controller(asset=new_asset)
        self.until("done")
        rendered = self.resource_state[("Deployment", "newsletter-config-sync")]
        self.assertIn(
            {"name": "SYNTHETIC_NEW_TEMPLATE", "value": "new"},
            rendered["spec"]["template"]["spec"]["containers"][0]["env"],
        )

    def test_dependency_failures_remain_held_after_restart_and_require_exact_resume(
        self,
    ):
        self.create()
        self.kube.fail = True
        self.controller.step()
        held = self.store.get(IDENTITY)
        self.assertEqual((held.phase, held.error_code), ("held", "UNAVAILABLE"))
        self.store = Store(self.store.path)
        self.controller = self.make_controller()
        self.assertFalse(self.controller.step())
        self.assertEqual(self.create().etag, held.etag)
        with self.assertRaises(RpcError) as error:
            self.controller.resume(
                api.ResumeReleaseRequest(
                    name="releases/" + IDENTITY, request_id=CONTINUE, etag="stale"
                )
            )
        self.assertEqual(error.exception.code, "ABORTED")
        request = api.ResumeReleaseRequest(
            name="releases/" + IDENTITY, request_id=CONTINUE, etag=held.etag
        )
        resumed = self.controller.resume(request)
        self.assertEqual(resumed.phase, "accepted")
        self.assertEqual(self.controller.resume(request).etag, resumed.etag)
        self.kube.fail = False
        self.until("done")
        self.assertEqual(self.controller.resume(request).phase, "ready")

    def test_invalid_or_changed_frozen_targets_never_reset_a_release(self):
        self.create()
        altered = pb.ReleaseTarget(
            workload_key="newsletter",
            source_sha=SHA,
            image_digest="sha256:" + "e" * 64,
            request_id=REQUEST,
        )
        for targets, status in (
            (TARGETS[:1], "INVALID_ARGUMENT"),
            ((TARGETS[0], TARGETS[0]), "INVALID_ARGUMENT"),
            ((altered, TARGETS[1]), "ALREADY_EXISTS"),
        ):
            with self.subTest(targets=targets), self.assertRaises(RpcError) as error:
                self.controller.create(
                    api.CreateReleaseRequest(
                        release_id=IDENTITY,
                        request_id=REQUEST,
                        release=pb.Release(targets=targets),
                    )
                )
            self.assertEqual(error.exception.code, status)
        self.assertEqual(self.store.get(IDENTITY).revision, 1)
        self.assertEqual(self.events, [])

    def test_ledger_and_live_sqlite_companions_are_owner_only(self):
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        with self.store.transaction() as database:
            database.execute(
                "INSERT INTO create_receipts VALUES (?,?)", (REQUEST, IDENTITY)
            )
            for companion in self.store.path.parent.glob("ledger.sqlite3*"):
                self.assertEqual(companion.stat().st_mode & 0o777, 0o600)

    def test_concurrent_create_has_one_durable_identity_and_one_active_operation(self):
        barrier = threading.Barrier(3)
        results = []

        def create():
            barrier.wait()
            results.append(self.create().etag)

        threads = [threading.Thread(target=create) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()
        self.assertEqual(len(set(results)), 1)
        with self.assertRaises(RpcError) as error:
            self.controller.create(
                api.CreateReleaseRequest(
                    release_id=CONTINUE,
                    request_id=REQUEST,
                    release=pb.Release(targets=TARGETS),
                )
            )
        self.assertEqual(error.exception.reason, "RELEASE_CONFLICT")


class Rendering(unittest.TestCase):
    def test_operational_fields_are_separate_and_bootstrap_defaults_are_preserved(self):
        source = asset()
        rendered = Renderer(CONFIG, asset=source).render(TARGETS, IDENTITY)
        for items, primary in ((source["items"], False), (rendered, True)):
            with self.subTest(primary=primary):
                selected = {
                    (item["kind"], item["metadata"]["name"]): item for item in items
                }
                for name in ("newsletter-release", "platform-release"):
                    data = selected[("ConfigMap", name)]["data"]
                    if primary:
                        self.assertNotIn("phase", data)
                        self.assertEqual(
                            set(data), {"source_sha", "image", "request_id"}
                        )
                    else:
                        self.assertEqual(data["phase"], "applying")
                daily = selected[("CronJob", "newsletter-daily")]["spec"]
                if primary:
                    self.assertNotIn("suspend", daily)
                else:
                    self.assertIs(daily["suspend"], True)
                self.assertIs(
                    selected[("CronJob", "platform-observer")]["spec"]["suspend"],
                    False,
                )

    def test_observer_profile_identity_and_namespace_follow_the_cluster_configuration(
        self,
    ):
        config = replace(
            CONFIG,
            node_key="second-node",
            namespace="isolated",
            workloads=(
                CONFIG.workloads[0],
                replace(CONFIG.workloads[1], deployment="alternate-platform"),
            ),
        )
        source = asset()
        observer_source = next(
            item
            for item in source["items"]
            if item["metadata"]["name"] == "platform-observer"
        )
        source_env = {
            item["name"]: item
            for item in observer_source["spec"]["jobTemplate"]["spec"]["template"][
                "spec"
            ]["containers"][0]["env"]
        }
        observer = next(
            item
            for item in Renderer(config, asset=source).render(TARGETS, IDENTITY)
            if item["metadata"]["name"] == "platform-observer"
        )
        env = {
            item["name"]: item
            for item in observer["spec"]["jobTemplate"]["spec"]["template"]["spec"][
                "containers"
            ][0]["env"]
        }
        self.assertEqual(observer["metadata"]["namespace"], "isolated")
        self.assertEqual(env["FLEET_HOST_KEY"]["value"], "second-node")
        self.assertNotIn("value", env["FLEET_KUBE_NAMESPACE"])
        self.assertEqual(
            env["FLEET_KUBE_NAMESPACE"]["valueFrom"],
            {"fieldRef": {"fieldPath": "metadata.namespace"}},
        )
        self.assertEqual(env["FLEET_REPORT_URL"], source_env["FLEET_REPORT_URL"])
        self.assertEqual(
            env["FLEET_RUNTIME_URL"]["value"],
            "http://alternate-platform:8080/api/v1/nodeStatus",
        )

    def test_only_baked_resources_and_fixed_repository_images_can_be_rendered(self):
        values = Renderer(CONFIG, asset=asset()).render(TARGETS, IDENTITY)
        self.assertEqual(len(values), 10)
        self.assertTrue(
            all(item["metadata"]["namespace"] == CONFIG.namespace for item in values)
        )
        for item in values:
            if item["kind"] == "CronJob":
                observer = item["metadata"]["name"] == "platform-observer"
                if observer:
                    self.assertIs(item["spec"]["suspend"], False)
                else:
                    self.assertNotIn("suspend", item["spec"])
                expected = (
                    "ghcr.io/example/project-platform@" + TARGETS[1].image_digest
                    if observer
                    else "ghcr.io/example/project-newsletter@" + TARGETS[0].image_digest
                )
                pod = item["spec"]["jobTemplate"]["spec"]["template"]["spec"]
                self.assertTrue(
                    all(
                        container["image"] == expected
                        for container in (
                            *pod.get("initContainers", []),
                            *pod["containers"],
                        )
                    )
                )
                if observer:
                    self.assertEqual(
                        pod["initContainers"][0]["args"], ["observer-systemd"]
                    )
                    self.assertEqual(
                        pod["initContainers"][0]["env"],
                        [
                            {
                                "name": "FLEET_EXPECTED_DAEMONS",
                                "value": json.dumps(
                                    list(CONFIG.expected_daemons), separators=(",", ":")
                                ),
                            }
                        ],
                    )
                    self.assertFalse(pod["automountServiceAccountToken"])
            if item["kind"] == "Deployment":
                self.assertEqual(item["spec"]["strategy"], {"type": "Recreate"})
                expected = (
                    "ghcr.io/example/project-platform@" + TARGETS[1].image_digest
                    if item["metadata"]["name"] == "platform-runtime"
                    else "ghcr.io/example/project-newsletter@" + TARGETS[0].image_digest
                )
                pod = item["spec"]["template"]["spec"]
                self.assertTrue(
                    all(
                        container["image"] == expected
                        for container in (
                            *pod.get("initContainers", []),
                            *pod["containers"],
                        )
                    )
                )
        config = next(
            item
            for item in values
            if item["metadata"]["name"] == "platform-runtime-config"
        )
        self.assertEqual(
            json.loads(config["data"]["runtime.json"])["repository"], "example/project"
        )
        self.assertEqual(
            image(CONFIG, "personal-cloud", TARGETS[1].image_digest),
            "ghcr.io/example/project-platform@" + TARGETS[1].image_digest,
        )
        altered = asset()
        altered["items"][0]["kind"] = "Secret"
        with self.assertRaises(ValueError):
            Renderer(CONFIG, asset=altered)


class PrivateHTTP(unittest.TestCase):
    def client(self, value, status=200, **headers):
        return httpx.Client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    status,
                    headers={"Content-Type": "application/json", **headers},
                    stream=httpx.ByteStream(json.dumps(value).encode()),
                )
            ),
            trust_env=False,
            follow_redirects=False,
        )

    def test_drain_validation_handles_busy_and_never_follows_redirects(self):
        with self.client(drain("frozen", IDENTITY)) as client:
            self.assertEqual(
                Admission("synthetic-token", client=client).call("freeze", IDENTITY)[
                    "state"
                ],
                "frozen",
            )
        with (
            self.client({"error": "deployment_busy"}, status=409) as client,
            self.assertRaises(AdmissionBusy),
        ):
            Admission("synthetic-token", client=client).call("freeze", IDENTITY)
        with (
            self.client({"error": "deployment_conflict"}, status=409) as client,
            self.assertRaises(AdmissionConflict),
        ):
            Admission("synthetic-token", client=client).call("begin", IDENTITY)
        with (
            self.client({}, status=302, Location="http://unconfigured") as client,
            self.assertRaises(AdmissionUnavailable),
        ):
            Admission("synthetic-token", client=client).call("begin", IDENTITY)
        for value in (
            drain("frozen", CONTINUE),
            {**drain(), "busy": True},
            {**drain(), "state": "unknown"},
        ):
            with self.subTest(value=value), self.assertRaises(AdmissionUnavailable):
                Admission.validate(value, "freeze", IDENTITY)


class MachineAPI(Fixture, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = patch("personal_cloud.deployment.store.now", return_value=STAMP)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.initialize()

    async def test_typed_create_get_resume_and_output_only_rejection_are_content_free(
        self,
    ):
        service = Service(
            Cache(SimpleNamespace(collect=self.snapshot)),
            ("newsletter", "platform-runtime"),
        )
        router = Router(self.controller, "synthetic-release-token")
        service.summary = router.summary
        app = create_app(service, router)
        headers = {"Authorization": "Bearer synthetic-release-token"}
        query = "?release_id=" + IDENTITY + "&request_id=" + REQUEST
        body = {"targets": [to_wire(target) for target in TARGETS]}
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://synthetic"
            ) as client,
        ):
            denied = await client.post("/api/v1/releases" + query, content=b"not-json")
            self.assertEqual(denied.status_code, 401)
            invalid = await client.post(
                "/api/v1/releases" + query,
                json={**body, "phase": "ready"},
                headers=headers,
            )
            self.assertEqual(invalid.status_code, 400)
            self.assertIsNone(self.store.latest())
            accepted = await client.post(
                "/api/v1/releases" + query, json=body, headers=headers
            )
            self.assertEqual(
                (accepted.status_code, accepted.json()["phase"]), (200, "accepted")
            )
            from_wire(pb.Release, accepted.json(), strict=True)
            repeated = await client.post(
                "/api/v1/releases" + query, json=body, headers=headers
            )
            self.assertEqual(accepted.json(), repeated.json())
            fetched = await client.get("/api/v1/releases/" + IDENTITY, headers=headers)
            self.assertEqual(fetched.json(), accepted.json())
            self.kube.fail = True
            self.controller.step()
            observed = await client.get("/api/v1/nodeStatus")
            self.assertEqual(observed.json()["current_release"]["phase"], "held")
            held = self.store.get(IDENTITY)
            resumed = await client.post(
                "/api/v1/releases/" + IDENTITY + ":resume",
                json={"request_id": CONTINUE, "etag": held.etag},
                headers=headers,
            )
            self.assertEqual(
                (resumed.status_code, resumed.json()["phase"]), (200, "accepted")
            )
        self.assertNotIn("Bearer", json.dumps(accepted.json()))
        self.assertNotIn("metadata", json.dumps(accepted.json()))


if __name__ == "__main__":
    unittest.main()
