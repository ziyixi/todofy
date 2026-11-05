"""Startup prepares Gateway's isolated state directory in the existing volume."""

import os
import stat
import tempfile
import threading
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from personal_cloud.deployment.controller import Controller
from personal_cloud.deployment.router import Router, create_router
from personal_cloud.deployment.store import Store
from ziyixi_proto.platform.runtime.v1 import runtime_pb as pb
from ziyixi_proto.wire_json import to_wire

IDENTITY = "afc6aa50-5a15-461d-b93c-dbd9115ccacb"
CONTINUE = "f219c057-fc33-4d8b-8819-d7a1f776b35f"
STAMP = "2026-10-02T12:00:00Z"


class StartupState(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state_dir = Path(directory.name) / "platform"
        environment = patch.dict(
            os.environ,
            {
                "PLATFORM_DEPLOY_TOKEN": "synthetic-platform-token-0001",
                "NEWSLETTER_SEND_TOKEN": "synthetic-newsletter-token-0002",
                "PLATFORM_STATE_DIR": str(self.state_dir),
            },
        )
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("Controller", "Client", "AdmissionClient", "Renderer"):
            replacement = patch("personal_cloud.deployment.router." + name)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.config = SimpleNamespace(namespace="synthetic")

    def test_startup_creates_owner_only_writable_directory_and_preserves_restart_state(
        self,
    ):
        create_router(self.config, object()).close()
        directory = self.state_dir / "codex-gateway"
        metadata = directory.stat()
        self.assertTrue(stat.S_ISDIR(metadata.st_mode))
        self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o700)
        self.assertEqual(metadata.st_uid, os.geteuid())
        self.assertEqual(metadata.st_gid, os.getegid())
        self.assertTrue((self.state_dir / "releases.sqlite3").is_file())
        marker = directory / "synthetic-state"
        marker.write_text("retained")

        create_router(self.config, object()).close()
        self.assertEqual(marker.read_text(), "retained")
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(
            {item.name for item in directory.iterdir()}, {"synthetic-state"}
        )

    def test_startup_preserves_an_existing_file_at_the_reserved_directory(self):
        self.state_dir.mkdir()
        collision = self.state_dir / "codex-gateway"
        collision.write_text("preserve-existing-state")
        with self.assertRaises(FileExistsError):
            create_router(self.config, object())
        self.assertEqual(collision.read_text(), "preserve-existing-state")


class RouterAndBackgroundController(unittest.TestCase):
    def test_reconcile_routes_and_background_worker_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "ledger.sqlite3")
            kube = SimpleNamespace(close=Mock())
            admission = SimpleNamespace(close=Mock())
            renderer = SimpleNamespace(
                workloads={
                    "newsletter": SimpleNamespace(key="newsletter"),
                    "personal-cloud": SimpleNamespace(key="platform-runtime"),
                }
            )
            controller = Controller(
                SimpleNamespace(namespace="personal-cloud"),
                store,
                kube,
                admission,
                renderer,
                SimpleNamespace(),
                clock=lambda: datetime(2026, 10, 2, 12, tzinfo=UTC),
            )
            plan = pb.ReconcilePlan(
                name="reconcilePlan",
                base_release="releases/" + IDENTITY,
                base_etag="etag-1",
                state="repairable",
                fingerprint="a" * 64,
                observed_at=STAMP,
                changes=(
                    pb.ReconcileChange(
                        resource_key="newsletter",
                        action="update",
                        reason_code="RUNTIME_FIELDS_CHANGED",
                    ),
                ),
            )
            controller.planner.collect = Mock(return_value=plan)
            release = pb.Release(
                name="releases/" + CONTINUE,
                request_id=CONTINUE,
                targets=(
                    pb.ReleaseTarget(
                        workload_key="newsletter",
                        source_sha="a" * 40,
                        image_digest="sha256:" + "b" * 64,
                        request_id=CONTINUE,
                    ),
                ),
                phase="accepted",
                etag="etag-2",
                create_time=STAMP,
                update_time=STAMP,
                source_release="releases/" + IDENTITY,
            )
            controller.reconcile = Mock(return_value=release)
            router = Router(controller, "synthetic-release-token")
            headers = {"Authorization": "Bearer synthetic-release-token"}

            code, wire_plan = router.handle(
                "GET", "/api/v1/reconcilePlan", headers, lambda: None
            )
            self.assertEqual((code, wire_plan), (200, to_wire(plan)))
            self.assertEqual(router.plan(), plan)
            controller.planner.collect.assert_called_once()

            code, wire_release = router.handle(
                "POST",
                f"/api/v1/releases/{IDENTITY}:reconcile",
                headers,
                lambda: {
                    "etag": "etag-1",
                    "fingerprint": "a" * 64,
                    "request_id": CONTINUE,
                },
            )
            self.assertEqual((code, wire_release), (200, to_wire(release)))
            called_request = controller.reconcile.call_args.args[0]
            self.assertEqual(
                (
                    called_request.name,
                    called_request.etag,
                    called_request.fingerprint,
                    called_request.request_id,
                ),
                ("releases/" + IDENTITY, "etag-1", "a" * 64, CONTINUE),
            )

            ran = threading.Event()
            outcomes = [RuntimeError("synthetic-failure"), True, False]

            def fake_step():
                item = outcomes.pop(0) if outcomes else False
                if isinstance(item, Exception):
                    raise item
                if not outcomes:
                    ran.set()
                return item

            controller.step = fake_step
            controller.start()
            with self.assertRaises(RuntimeError):
                controller.start()
            controller.wake.set()
            self.assertTrue(ran.wait(timeout=5))
            self.assertIsNone(controller.worker_error)
            router.close()
            self.assertFalse(controller.thread.is_alive())
            admission.close.assert_called_once()
            kube.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
