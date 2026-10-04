"""Current-version owner recovery with synthetic ledgers and no system operations."""

import json
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from personal_cloud.deployment.store import Store

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))
import prepare
import recover

import config

SHA = "a" * 40
IDENTITY = "46969b07-65a4-49a7-b62f-66f4234160ac"
IMAGES = {
    "newsletter": "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "b" * 64,
    "platform": "ghcr.io/ziyixi/todofy-platform@sha256:" + "c" * 64,
}


class CurrentRecovery(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.bundle = self.base / "bundle"
        prepare.prepare(ROOT, SHA, IMAGES, self.bundle)
        self.public = config.load_bundle(self.bundle)
        self.ledger = self.base / "releases.sqlite3"
        self.store = Store(self.ledger)
        self.body = {
            "request_id": IDENTITY,
            "targets": [
                {
                    "workload_key": "platform-runtime" if key == "platform" else key,
                    "source_sha": SHA,
                    "image_digest": value.split("@")[1],
                    "request_id": IDENTITY,
                }
                for key, value in IMAGES.items()
            ],
        }
        self.store.create(IDENTITY, self.body)
        self.store.checkpoint(IDENTITY, "ready", "done")

    def test_restore_only_current_daemon_and_control_fields_preserving_private_state(
        self,
    ):
        applied, commands = [], []
        sentinel = self.base / "newsletter-private-state"
        sentinel.write_bytes(b"never inspect or rewrite this")
        before = self.store.latest()

        def kubectl(argv, **options):
            commands.append((argv, options))
            output = (
                b"deployment.apps/platform-runtime\n"
                if "--ignore-not-found" in argv
                else b""
            )
            return CompletedProcess(argv, 0, stdout=output, stderr=b"")

        with (
            patch.object(recover.os, "geteuid", return_value=0),
            patch.object(
                recover, "__file__", str(self.bundle / "installer/recover.py")
            ),
            patch.object(recover.host, "bootstrap_completed", return_value=True),
            patch.object(recover.host, "real_path", return_value=self.ledger),
            patch.object(recover, "host_services") as services,
            patch.object(recover.cluster, "kubectl", side_effect=kubectl),
            patch.object(
                recover.cluster,
                "apply",
                side_effect=lambda item: applied.append(deepcopy(item)),
            ),
        ):
            result = recover.recover(self.bundle, self.bundle)
        services.assert_called_once_with(self.bundle, self.bundle)
        self.assertEqual(
            (result["status"], result["release"]),
            ("runtime_restored", "releases/" + IDENTITY),
        )
        self.assertEqual(self.store.latest(), before)
        self.assertEqual(sentinel.read_bytes(), b"never inspect or rewrite this")
        self.assertEqual(
            {(item["kind"], item["metadata"]["name"]) for item in applied},
            {
                ("Deployment", "platform-runtime"),
                ("Service", "platform-runtime"),
                ("ConfigMap", "platform-runtime-config"),
                ("ConfigMap", "platform-release"),
            },
        )
        release = next(
            x for x in applied if x["metadata"]["name"] == "platform-release"
        )
        self.assertEqual(release["data"]["request_id"], IDENTITY)
        self.assertNotIn("phase", release["data"])
        writes = [
            (argv, options)
            for argv, options in commands
            if "apply" in argv or "patch" in argv
        ]
        self.assertEqual(len(writes), 2)
        self.assertIn("--field-manager=personal-cloud", writes[0][0])
        self.assertNotIn("scale", writes[0][0])
        self.assertEqual(
            json.loads(writes[1][1]["data"])["data"], {"phase": "activated"}
        )
        self.assertFalse(
            any("secret" in argv and "apply" in argv for argv, _ in commands)
        )

    def test_current_bundle_identity_is_checked_before_host_changes(self):
        foreign = {**self.public, "source_sha": "e" * 40}
        with (
            patch.object(recover.os, "geteuid", return_value=0),
            patch.object(
                recover, "__file__", str(self.bundle / "installer/recover.py")
            ),
            patch.object(recover.host, "bootstrap_completed", return_value=True),
            patch.object(recover.host, "real_path", return_value=self.ledger),
            patch.object(recover, "load_bundle", side_effect=[self.public, foreign]),
            patch.object(recover, "host_services") as services,
            patch.object(recover.cluster, "kubectl") as kubectl,
            self.assertRaisesRegex(
                config.BootstrapError, "RECOVERY_BUNDLE_NOT_CURRENT_ACCEPTED"
            ),
        ):
            recover.recover(self.bundle, self.bundle)
        services.assert_not_called()
        kubectl.assert_not_called()

    def test_empty_ledger_never_becomes_a_fresh_install(self):
        with self.store.transaction() as database:
            database.execute("DELETE FROM releases")
        with (
            patch.object(recover.host, "real_path", return_value=self.ledger),
            self.assertRaisesRegex(config.BootstrapError, "RECOVERY_RELEASE_MISSING"),
        ):
            recover.accepted_release(self.public["profile"], self.public)

    def test_ready_and_inflight_activation_are_derived_from_the_ledger(self):
        with patch.object(recover.host, "real_path", return_value=self.ledger):
            self.assertEqual(
                recover.accepted_release(self.public["profile"], self.public)[
                    "activation"
                ],
                "activated",
            )
            self.store.checkpoint(IDENTITY, "verifying", "verify")
            self.assertEqual(
                recover.accepted_release(self.public["profile"], self.public)[
                    "activation"
                ],
                "applying",
            )
            self.store.checkpoint(IDENTITY, "held", "resume")
            self.assertEqual(
                recover.accepted_release(self.public["profile"], self.public)[
                    "activation"
                ],
                "activated",
            )

    def test_missing_runtime_is_recreated_without_scale_or_secret_mutation(self):
        commands = []

        def kubectl(argv, **options):
            commands.append(argv)
            return CompletedProcess(argv, 0, stdout=b"", stderr=b"")

        with (
            patch.object(recover.os, "geteuid", return_value=0),
            patch.object(
                recover, "__file__", str(self.bundle / "installer/recover.py")
            ),
            patch.object(recover.host, "bootstrap_completed", return_value=True),
            patch.object(recover.host, "real_path", return_value=self.ledger),
            patch.object(recover, "host_services"),
            patch.object(recover.cluster, "kubectl", side_effect=kubectl),
            patch.object(recover.cluster, "apply") as apply,
        ):
            recover.recover(self.bundle, self.bundle)
        self.assertEqual(apply.call_count, 4)
        self.assertFalse(any("patch" in argv or "scale" in argv for argv in commands))

    def test_host_version_and_template_changes_require_review(self):
        other = self.base / "other"
        prepare.prepare(ROOT, SHA, IMAGES, other)
        versions = config.read_json(other / "versions.json")
        versions["k3s"]["version"] = "v1.33.1+k3s1"
        (other / "versions.json").write_text(json.dumps(versions))
        with (
            patch.object(recover.host, "write_file") as write,
            patch.object(recover, "command") as command,
            self.assertRaisesRegex(
                config.BootstrapError, "RECOVERY_HOST_VERSION_REVIEW_REQUIRED"
            ),
        ):
            recover.host_services(self.bundle, other)
        write.assert_not_called()
        command.assert_not_called()
