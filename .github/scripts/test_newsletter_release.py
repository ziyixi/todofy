"""An untested, wrong-SHA or damaged artifact must never be pushed."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("newsletter_image", REPO / "tools/container-release/image.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ImageRelease(unittest.TestCase):
    def fixture(self, root):
        root = Path(root)
        (root / "image.tar").write_bytes(b"synthetic docker archive")
        manifest = {"version": 1, "sha": "a" * 40, "image_id": "sha256:" + "b" * 64,
                    "archive_sha256": release.digest(root / "image.tar")}
        (root / "manifest.json").write_text(json.dumps(manifest))
        return root, manifest

    def test_publish_loads_and_pushes_the_tested_id_without_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, manifest = self.fixture(tmp)
            with patch.object(release.subprocess, "run") as run, patch.object(release, "inspect", return_value=manifest["image_id"]), patch.object(release, "registry_digest", return_value="ghcr.io/ziyixi/todofy-newsletter@sha256:" + "d" * 64):
                release.publish("a" * 40, root)
            calls = [call.args[0] for call in run.call_args_list]
            self.assertEqual(calls[0], ["docker", "load", "--input", str(root / "image.tar")])
            self.assertEqual(calls[1:3], [["docker", "tag", manifest["image_id"], "ghcr.io/ziyixi/todofy-newsletter:service-" + "a" * 40],
                                        ["docker", "push", "ghcr.io/ziyixi/todofy-newsletter:service-" + "a" * 40]])
            self.assertFalse(any("build" in call for call in calls))

    def test_registry_digest_requires_one_pullable_manifest_identity(self):
        expected = "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "d" * 64
        for values, valid in (([expected, expected], True), ([], False), (["sha256:" + "d" * 64], False),
                              ([expected, "ghcr.io/ziyixi/todofy-newsletter@sha256:" + "e" * 64], False)):
            with self.subTest(values=values), patch.object(release.subprocess, "check_output", return_value=json.dumps(values)):
                if valid:
                    self.assertEqual(release.registry_digest("tested"), expected)
                else:
                    with self.assertRaises(ValueError):
                        release.registry_digest("tested")

    def test_wrong_sha_checksum_or_manifest_cannot_invoke_docker(self):
        for change in ("sha", "bytes", "field", "symlink"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                root, manifest = self.fixture(tmp)
                sha = "c" * 40 if change == "sha" else "a" * 40
                if change == "bytes":
                    (root / "image.tar").write_bytes(b"changed archive")
                elif change == "field":
                    manifest["version"] = True
                    (root / "manifest.json").write_text(json.dumps(manifest))
                elif change == "symlink":
                    (root / "alias.tar").write_bytes(b"synthetic docker archive")
                    (root / "image.tar").unlink()
                    (root / "image.tar").symlink_to(root / "alias.tar")
                with patch.object(release.subprocess, "run") as run, self.assertRaises(ValueError):
                    release.publish(sha, root)
                run.assert_not_called()

    def test_loaded_image_mismatch_cannot_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, _ = self.fixture(tmp)
            with patch.object(release.subprocess, "run") as run, patch.object(release, "inspect", return_value="sha256:" + "c" * 64):
                with self.assertRaises(ValueError):
                    release.publish("a" * 40, root)
            self.assertEqual(len(run.call_args_list), 1)
