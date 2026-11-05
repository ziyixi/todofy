"""Synthetic recovery orchestration and metadata boundaries; no host or cluster writes."""

import contextlib
import copy
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

ROOT = Path(__file__).absolute().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))
import install
import reader
import repair
import repair_checks
import repair_kube

from config import BootstrapError

SHA = "b" * 40
PROFILE = {
    "namespace": "personal-cloud",
    "state_root": "/srv/todofy",
    "repository": "ziyixi/todofy",
}
OLD = {"source_sha": repair_checks.PREVIOUS_SHA, "profile": PROFILE}
NEW = {
    "source_sha": SHA,
    "profile": PROFILE,
    "images": {"newsletter": "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "c" * 64},
}
IDENTITY = {
    "schema_version": 1,
    "previous_bundle_sha256": repair_checks.PREVIOUS_MANIFEST,
    "bundle_sha256": "d" * 64,
}


class FakeRuntime:
    def __init__(self, *, failure=None):
        self.calls = []
        self.failure = failure
        self.jobs = []

    def daily_jobs(self):
        self.calls.append("daily")
        return self.jobs

    def expected(self, old, new=None, *, first=False):
        self.calls.append(("expected", first))
        if self.failure == "precheck":
            raise BootstrapError("REPAIR_RUNTIME_CHANGED")

    def admission(self, previous_sha):
        self.calls.append("admission")
        if self.failure == "busy":
            raise BootstrapError("REPAIR_ADMISSION_NOT_QUIET")
        return {"unknown": {"historical": 1}, "queued": {"editions": 2}}

    def stop(self):
        self.calls.append("stop")

    def gate_job(self, value):
        self.calls.append(("job", value))
        if self.failure == "gate":
            raise BootstrapError("REPAIR_GATE_JOB_FAILED")
        return {"request_key": "release-" + SHA}


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        (self.directory / "installer").mkdir()
        (self.directory / "installer/repair_gate.py").write_text(
            (ROOT / "tools/vps-bootstrap/repair_gate.py").read_text()
        )
        self.runtime = FakeRuntime()
        self.checkpoints = []
        self.marker = None
        patches = {
            "inputs": lambda *args: (OLD, NEW, {"old": True}, {"new": True}),
            "marker_identity": lambda *args: IDENTITY,
            "current": lambda *args: self.marker,
            "empty_ledger": lambda *args: self.runtime.calls.append("ledger"),
            "Runtime": lambda *args: self.runtime,
            "checkpoint": self.checkpoint,
            "event": lambda *args: None,
        }
        for name, replacement in patches.items():
            self.addCleanup(patch.stopall)
            patch.object(repair, name, replacement).start()
        patch.object(repair.os, "geteuid", return_value=0).start()
        self.apply = patch.object(repair.cluster, "held_runtime").start()

    def checkpoint(self, identity, phase, jobs):
        self.checkpoints.append(phase)
        self.marker = {**identity, "phase": phase, "daily_job_uids": jobs}
        return self.marker

    def test_repair_stops_before_transfer_then_applies_only_held_bundle(self):
        repair.repair(self.directory, self.directory)
        self.assertEqual(
            self.checkpoints,
            ["stopping", "stopped", "gate_transfer", "gate_frozen", "complete_held"],
        )
        kinds = [
            item[0] if isinstance(item, tuple) else item for item in self.runtime.calls
        ]
        self.assertLess(kinds.index("stop"), kinds.index("job"))
        self.apply.assert_called_once_with(self.directory, "personal-cloud")
        self.assertEqual(
            self.marker["previous_bundle_sha256"], repair_checks.PREVIOUS_MANIFEST
        )

    def test_running_business_is_not_stopped_or_interrupted(self):
        self.runtime.failure = "busy"
        with self.assertRaisesRegex(BootstrapError, "REPAIR_ADMISSION_NOT_QUIET"):
            repair.repair(self.directory, self.directory)
        self.assertNotIn("stop", self.runtime.calls)
        self.assertFalse(self.checkpoints)
        self.apply.assert_not_called()

    def test_gate_failure_never_applies_and_keeps_every_process_stopped(self):
        self.runtime.failure = "gate"
        with self.assertRaisesRegex(BootstrapError, "REPAIR_GATE_JOB_FAILED"):
            repair.repair(self.directory, self.directory)
        self.assertEqual(self.runtime.calls.count("stop"), 2)
        self.apply.assert_not_called()
        self.assertEqual(self.marker["phase"], "gate_transfer")

    def test_partial_new_apply_failure_returns_business_to_zero(self):
        self.apply.side_effect = BootstrapError("SYSTEM_COMMAND_FAILED")
        with self.assertRaises(BootstrapError):
            repair.repair(self.directory, self.directory)
        self.assertEqual(self.runtime.calls.count("stop"), 2)
        self.assertEqual(self.marker["phase"], "gate_frozen")
        self.assertNotIn("complete_held", self.checkpoints)

    def test_retry_of_partial_gate_explicitly_uses_resume_interrupted(self):
        self.marker = {**IDENTITY, "phase": "gate_transfer", "daily_job_uids": []}
        repair.repair(self.directory, self.directory)
        job = next(
            item[1]
            for item in self.runtime.calls
            if isinstance(item, tuple) and item[0] == "job"
        )
        self.assertIn(
            "--resume-interrupted",
            job["spec"]["template"]["spec"]["containers"][0]["command"],
        )

    def test_repaired_marker_never_reapplies_or_changes_the_original_bootstrap(self):
        self.marker = {**IDENTITY, "phase": "complete_held", "daily_job_uids": []}
        repair.repair(self.directory, self.directory)
        self.assertFalse(self.runtime.calls)
        self.apply.assert_not_called()
        self.assertFalse(self.checkpoints)

    def test_new_daily_job_or_precondition_failure_is_not_ignored(self):
        self.marker = {**IDENTITY, "phase": "stopped", "daily_job_uids": ["expected"]}
        with self.assertRaisesRegex(BootstrapError, "REPAIR_NEW_DAILY_JOB"):
            repair.repair(self.directory, self.directory)
        self.apply.assert_not_called()
        self.assertFalse(self.checkpoints)

    def test_maintenance_job_has_only_data_and_no_api_or_provider_identity(self):
        job = repair.maintenance_job(self.directory, OLD, NEW)
        pod = job["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 10001)
        self.assertEqual(
            pod["volumes"],
            [
                {
                    "name": "data",
                    "persistentVolumeClaim": {"claimName": "newsletter-data"},
                }
            ],
        )
        container = pod["containers"][0]
        self.assertEqual(container["image"], NEW["images"]["newsletter"])
        self.assertEqual(container["command"][0], "python")
        self.assertNotIn("env", container)
        self.assertNotIn("envFrom", container)
        self.assertEqual(job["spec"]["backoffLimit"], 0)


class RepairMetadataTests(unittest.TestCase):
    def test_nonempty_release_ledger_refuses_repair_without_selecting_request_bodies(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "platform").mkdir()
            path = root / "platform/releases.sqlite3"
            connection = sqlite3.connect(path)
            for table in ("releases", "create_receipts", "resume_receipts"):
                connection.execute(f"CREATE TABLE {table}(identity TEXT, body TEXT)")
            connection.commit()
            profile = {"state_root": str(root)}
            repair_checks.empty_ledger(profile)
            connection.execute(
                "INSERT INTO releases VALUES('existing','must-not-be-read')"
            )
            connection.commit()
            with self.assertRaisesRegex(BootstrapError, "REPAIR_API_RELEASE_EXISTS"):
                repair_checks.empty_ledger(profile)
            connection.close()

    def test_old_manifest_mismatch_fails_before_loading_or_touching_cluster(self):
        with (
            patch.object(repair_checks, "checksum", return_value="wrong"),
            patch.object(repair_checks, "load_bundle") as load,
        ):
            with self.assertRaisesRegex(
                BootstrapError, "REPAIR_PREVIOUS_BUNDLE_MISMATCH"
            ):
                repair_checks.inputs("old", "new")
            load.assert_not_called()

    def test_physical_identity_retains_claims_but_ignores_sdk_default_mode(self):
        pod = {
            "containers": [
                {
                    "name": "app",
                    "image": "pin",
                    "env": [
                        {"name": "NEWSLETTER_RELEASE_REQUEST_ID", "value": "original"}
                    ],
                    "volumeMounts": [{"name": "state", "mountPath": "/state"}],
                }
            ],
            "volumes": [
                {"name": "state", "persistentVolumeClaim": {"claimName": "fixed"}}
            ],
        }
        defaulted = copy.deepcopy(pod)
        defaulted["volumes"][0]["persistentVolumeClaim"]["readOnly"] = False
        self.assertTrue(repair_kube.declared_fields(defaulted, pod))
        defaulted["volumes"][0]["persistentVolumeClaim"]["claimName"] = "other"
        self.assertFalse(repair_kube.declared_fields(defaulted, pod))
        defaulted = copy.deepcopy(pod)
        defaulted["containers"][0]["env"][0]["value"] = "forged"
        self.assertFalse(repair_kube.declared_fields(defaulted, pod))

    def test_marker_identity_conflict_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "repair.json"
            marker.write_text(
                json.dumps({**IDENTITY, "phase": "stopped", "daily_job_uids": []})
            )
            marker.chmod(0o600)
            with (
                patch.object(repair, "MARKER", marker),
                patch.object(repair.host, "real_path", side_effect=lambda path: path),
                patch.object(
                    repair,
                    "read_json",
                    return_value={
                        **IDENTITY,
                        "bundle_sha256": "different",
                        "phase": "stopped",
                        "daily_job_uids": [],
                    },
                ),
                patch.object(Path, "stat") as attributes,
            ):
                attributes.return_value.st_uid = 0
                attributes.return_value.st_mode = 0o100600
                with self.assertRaisesRegex(BootstrapError, "REPAIR_MARKER_CONFLICT"):
                    repair.current(IDENTITY)


class RuntimePreconditionTests(unittest.TestCase):
    def setUp(self):
        self.runtime = repair_kube.Runtime("personal-cloud")
        self.items = []
        self.deployments = {}
        self.maps = {}
        self.pods = {}
        image = "ghcr.io/ziyixi/todofy-platform@sha256:" + "e" * 64
        for name in repair_kube.DEPLOYMENTS:
            pod = {
                "serviceAccountName": "fixed-account",
                "automountServiceAccountToken": False,
                "securityContext": {"runAsNonRoot": True, "runAsUser": 10001},
                "containers": [
                    {
                        "name": "app",
                        "image": image,
                        "env": [
                            {
                                "name": "PLATFORM_RELEASE_REQUEST_ID",
                                "value": "frozen-identity",
                            }
                        ],
                        "securityContext": {"allowPrivilegeEscalation": False},
                        "volumeMounts": [{"name": "state", "mountPath": "/state"}],
                    }
                ],
                "volumes": [{"name": "state", "configMap": {"name": "fixed"}}],
            }
            wanted = {
                "kind": "Deployment",
                "metadata": {"name": name},
                "spec": {"replicas": 1, "template": {"spec": pod}},
            }
            self.items.append(wanted)
            actual = copy.deepcopy(wanted)
            actual["spec"]["template"]["spec"]["volumes"][0]["configMap"][
                "defaultMode"
            ] = 420
            self.deployments[name] = actual
            self.pods[name] = {
                "items": [
                    {
                        "status": {
                            "phase": "Running",
                            "containerStatuses": [
                                {"name": "app", "imageID": image, "ready": True}
                            ],
                        }
                    }
                ]
            }
        for name in ("newsletter-release", "platform-release"):
            item = {
                "kind": "ConfigMap",
                "metadata": {"name": name},
                "data": {"identity": "fixed"},
            }
            self.items.append(item)
            self.maps[name] = copy.deepcopy(item)
        self.resources = {"items": self.items}

        def get(kind, name):
            return self.deployments[name] if kind == "deployment" else self.maps[name]

        def call(args):
            from subprocess import CompletedProcess

            name = args[3].split("=", 1)[1]
            return CompletedProcess(args, 0, json.dumps(self.pods[name]).encode(), b"")

        self.runtime.get, self.runtime.call = get, call

    def test_realistic_configmap_api_defaults_do_not_block_verified_images(self):
        self.runtime.expected(self.resources, first=True)

    def test_wrong_service_account_is_rejected_even_if_image_labels_match(self):
        self.deployments["platform-runtime"]["spec"]["template"]["spec"][
            "serviceAccountName"
        ] = "admin"
        with self.assertRaisesRegex(BootstrapError, "REPAIR_RUNTIME_CHANGED"):
            self.runtime.expected(self.resources, first=True)

    def test_bare_container_config_id_does_not_prove_actual_manifest(self):
        self.pods["platform-runtime"]["items"][0]["status"]["containerStatuses"][0][
            "imageID"
        ] = "containerd://sha256:" + "e" * 64
        with self.assertRaisesRegex(BootstrapError, "REPAIR_PHYSICAL_IMAGE_INVALID"):
            self.runtime.expected(self.resources, first=True)

    def test_wrong_release_configmap_is_never_replaced_silently(self):
        self.maps["newsletter-release"]["data"]["identity"] = "another-operation"
        with self.assertRaisesRegex(BootstrapError, "REPAIR_RELEASE_CHANGED"):
            self.runtime.expected(self.resources, first=True)

    def test_pre_stop_admission_checks_actual_inflight_without_printing_response(self):
        from subprocess import CompletedProcess

        value = {
            "version": 1,
            "request_key": "release-" + repair_checks.PREVIOUS_SHA,
            "state": "frozen",
            "busy": False,
            "inflight": {"activities": 0},
            "unknown": {"delivery": 3},
            "queued": {"editions": 2},
        }
        self.runtime.call = lambda args: CompletedProcess(
            args, 0, json.dumps(value).encode(), b""
        )
        self.assertEqual(
            self.runtime.admission(repair_checks.PREVIOUS_SHA)["unknown"],
            {"delivery": 3},
        )
        value["inflight"]["activities"] = 1
        with self.assertRaisesRegex(BootstrapError, "REPAIR_ADMISSION_NOT_QUIET"):
            self.runtime.admission(repair_checks.PREVIOUS_SHA)

    def test_active_daily_job_or_unsuspended_schedule_refuses_repair(self):
        values = {
            "cronjob": {"spec": {"suspend": True}},
            "jobs": {
                "items": [
                    {
                        "metadata": {
                            "uid": "daily",
                            "ownerReferences": [
                                {"kind": "CronJob", "name": "newsletter-daily"}
                            ],
                        },
                        "status": {"active": 1},
                    }
                ]
            },
        }
        self.runtime.get = lambda kind, name=None: values[kind]
        with self.assertRaisesRegex(BootstrapError, "REPAIR_DAILY_JOB_RUNNING"):
            self.runtime.daily_jobs()
        values["cronjob"]["spec"]["suspend"] = False
        with self.assertRaisesRegex(BootstrapError, "REPAIR_DAILY_NOT_SUSPENDED"):
            self.runtime.daily_jobs()

    def test_runtime_and_inputs_validate_bundle_resources_images_and_host_files(self):
        newsletter_img = "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "1" * 64
        platform_img = "ghcr.io/ziyixi/todofy-platform@sha256:" + "2" * 64
        images = {"newsletter": newsletter_img, "platform": platform_img}

        def make_runtime_doc(source_sha: str):
            items = []
            for kind, name in sorted(repair_checks.RESOURCE_NAMES):
                svc = "platform" if name.startswith("platform-") else "newsletter"
                item = {
                    "kind": kind,
                    "metadata": {"name": name, "namespace": "personal-cloud"},
                }
                if kind == "Deployment":
                    item["spec"] = {
                        "replicas": 1,
                        "template": {
                            "spec": {
                                "initContainers": [{"image": images[svc]}],
                                "containers": [{"image": images[svc]}],
                            }
                        },
                    }
                elif kind == "CronJob":
                    item["spec"] = {
                        "suspend": name == "newsletter-daily",
                        "jobTemplate": {
                            "spec": {
                                "template": {
                                    "spec": {"containers": [{"image": images[svc]}]}
                                }
                            }
                        },
                    }
                elif kind == "ConfigMap" and name != "platform-runtime-config":
                    item["data"] = {
                        "image": images[svc],
                        "source_sha": source_sha,
                        "request_id": repair_checks.identity(source_sha),
                        "phase": "applying",
                    }
                items.append(item)
            return {"kind": "List", "items": items}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old_dir, new_dir = root / "old", root / "new"
            for d, sha in ((old_dir, repair_checks.PREVIOUS_SHA), (new_dir, SHA)):
                (d / "units").mkdir(parents=True)
                (d / "runtime.json").write_text(json.dumps(make_runtime_doc(sha)))
                (d / "foundation.json").write_text(json.dumps({"items": []}))
                for name in (
                    "versions.json",
                    "units/k3s.service",
                    "units/k3s-config.yaml",
                    "units/cloudflared-platform.service",
                    "units/firewall.v4",
                    "units/firewall.v6",
                ):
                    (d / name).write_text("fixed-host-content\n")

            old_public = {
                "source_sha": repair_checks.PREVIOUS_SHA,
                "profile": PROFILE,
                "images": images,
            }
            new_public = {
                "source_sha": SHA,
                "profile": PROFILE,
                "images": images,
            }
            self.assertEqual(repair_checks.runtime(new_dir, new_public)["kind"], "List")

            bad_images = {**new_public, "images": {**images, "newsletter": "bad"}}
            with self.assertRaisesRegex(BootstrapError, "REPAIR_IMAGES_INVALID"):
                repair_checks.runtime(new_dir, bad_images)

            unsuspended = make_runtime_doc(SHA)
            for item in unsuspended["items"]:
                if (
                    item["kind"] == "CronJob"
                    and item["metadata"]["name"] == "newsletter-daily"
                ):
                    item["spec"]["suspend"] = False
            (new_dir / "runtime.json").write_text(json.dumps(unsuspended))
            with self.assertRaisesRegex(BootstrapError, "REPAIR_RUNTIME_NOT_HELD"):
                repair_checks.runtime(new_dir, new_public)

            bad_cm = make_runtime_doc(SHA)
            for item in bad_cm["items"]:
                if (
                    item["kind"] == "ConfigMap"
                    and item["metadata"]["name"] == "newsletter-release"
                ):
                    item["data"]["phase"] = "ready"
            (new_dir / "runtime.json").write_text(json.dumps(bad_cm))
            with self.assertRaisesRegex(BootstrapError, "REPAIR_RELEASE_INVALID"):
                repair_checks.runtime(new_dir, new_public)

            (new_dir / "runtime.json").write_text(json.dumps(make_runtime_doc(SHA)))
            with (
                patch.object(
                    repair_checks,
                    "checksum",
                    return_value=repair_checks.PREVIOUS_MANIFEST,
                ),
                patch.object(
                    repair_checks,
                    "load_bundle",
                    side_effect=lambda d: (
                        old_public if Path(d) == old_dir else new_public
                    ),
                ),
                patch.object(
                    repair_checks.host, "bootstrap_completed", return_value=True
                ),
            ):
                prev, pub, old_rt, new_rt = repair_checks.inputs(old_dir, new_dir)
                self.assertEqual(prev["source_sha"], repair_checks.PREVIOUS_SHA)
                self.assertEqual(pub["source_sha"], SHA)
                self.assertEqual(old_rt["kind"], "List")
                self.assertEqual(new_rt["kind"], "List")

                (new_dir / "units/k3s.service").write_text("changed\n")
                with self.assertRaisesRegex(
                    BootstrapError, "REPAIR_HOST_CONFIGURATION_CHANGED"
                ):
                    repair_checks.inputs(old_dir, new_dir)

                (new_dir / "foundation.json").write_text(json.dumps({"items": [1]}))
                with self.assertRaisesRegex(
                    BootstrapError, "REPAIR_FOUNDATION_CHANGED"
                ):
                    repair_checks.inputs(old_dir, new_dir)


class RepairCliTests(unittest.TestCase):
    def test_fresh_install_also_requires_an_explicit_reader_flag(self):
        for flag in ([], ["--grant-reader"]):
            with (
                self.subTest(flag=flag),
                patch.object(
                    sys,
                    "argv",
                    [
                        "install",
                        "--bundle",
                        "/bundle",
                        "--credentials",
                        "/private",
                        *flag,
                    ],
                ),
                patch.object(install, "install") as setup,
                patch.object(
                    install,
                    "load_bundle",
                    return_value={"profile": {"namespace": "personal-cloud"}},
                ),
                patch.object(
                    reader, "install_reader", return_value="2027-10-03T00:00:00Z"
                ) as grant,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(install.main(), 0)
                setup.assert_called_once_with(Path("/bundle"), Path("/private"))
                if flag:
                    grant.assert_called_once_with("personal-cloud")
                else:
                    grant.assert_not_called()

    def test_reader_is_explicit_and_runs_only_after_successful_repair(self):
        for flag in ([], ["--grant-reader"]):
            with (
                self.subTest(flag=flag),
                patch.object(repair, "__file__", "/bundle/installer/repair.py"),
                patch.object(
                    sys,
                    "argv",
                    [
                        "repair",
                        "--previous-bundle",
                        "/old",
                        "--bundle",
                        "/bundle",
                        *flag,
                    ],
                ),
                patch.object(repair, "repair") as recover,
                patch.object(
                    repair,
                    "load_bundle",
                    return_value={"profile": {"namespace": "personal-cloud"}},
                ),
                patch.object(
                    repair, "install_reader", return_value="2027-10-03T00:00:00Z"
                ) as reader_fn,
                contextlib.redirect_stdout(io.StringIO()) as output,
            ):
                self.assertEqual(repair.main(), 0)
                recover.assert_called_once_with(Path("/old"), Path("/bundle"))
                if flag:
                    reader_fn.assert_called_once_with("personal-cloud")
                    self.assertEqual(
                        json.loads(output.getvalue()),
                        {
                            "event": "namespace_reader",
                            "expires_at": "2027-10-03T00:00:00Z",
                        },
                    )
                else:
                    reader_fn.assert_not_called()
                    self.assertEqual(output.getvalue(), "")

    def test_failed_repair_cannot_issue_reader_credentials(self):
        with (
            patch.object(repair, "__file__", "/bundle/installer/repair.py"),
            patch.object(
                sys,
                "argv",
                [
                    "repair",
                    "--previous-bundle",
                    "/old",
                    "--bundle",
                    "/bundle",
                    "--grant-reader",
                ],
            ),
            patch.object(
                repair,
                "repair",
                side_effect=BootstrapError("REPAIR_ADMISSION_NOT_QUIET"),
            ),
            patch.object(repair, "install_reader") as reader_fn,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            self.assertEqual(repair.main(), 1)
            reader_fn.assert_not_called()
            self.assertEqual(
                json.loads(output.getvalue())["error_code"],
                "REPAIR_ADMISSION_NOT_QUIET",
            )

    def test_retry_waits_for_previous_job_and_its_process_to_exit(self):
        job = {"metadata": {"name": "repair-job", "annotations": {"script": "fixed"}}}
        receipt = {
            "version": 1,
            "state": "frozen",
            "request_key": "new",
            "unknown": {},
            "queued": {},
        }
        runtime = repair_kube.Runtime("personal-cloud")
        calls = []

        def call(args, **kwargs):
            calls.append(args)
            value = job if args[0] == "get" else receipt if args[0] == "logs" else {}
            return CompletedProcess(args, 0, json.dumps(value).encode(), b"")

        with (
            patch.object(runtime, "call", side_effect=call),
            patch.object(
                runtime,
                "get",
                return_value={
                    "status": {"conditions": [{"type": "Complete", "status": "True"}]}
                },
            ),
            patch.object(repair_kube.cluster, "apply"),
        ):
            self.assertEqual(runtime.gate_job(job), receipt)
        self.assertIn(
            [
                "delete",
                "job",
                "repair-job",
                "--cascade=foreground",
                "--wait=true",
                "--timeout=60s",
            ],
            calls,
        )


if __name__ == "__main__":
    unittest.main()
