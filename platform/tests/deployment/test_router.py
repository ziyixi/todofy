"""Startup prepares Gateway's isolated state directory in the existing volume."""

import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from personal_cloud.deployment.router import create_router


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


if __name__ == "__main__":
    unittest.main()
