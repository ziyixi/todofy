"""Promotion starts only from the actual checkout and a matching loaded image."""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import build as image_build
import image as image_release


class ImageBuildIdentityTests(unittest.TestCase):
    def test_synthetic_zero_and_malformed_sha_never_start_tools(self):
        with patch.object(image_build.subprocess, "check_output") as run:
            for value in ("0" * 40, "HEAD", "a" * 39):
                with self.subTest(sha=value), self.assertRaises(ValueError):
                    image_build.build("newsletter", value)
            run.assert_not_called()

    def test_another_checkout_is_rejected_before_bazel_or_docker(self):
        with (
            patch.object(
                image_build.subprocess, "check_output", return_value="b" * 40 + "\n"
            ) as read,
            patch.object(image_build.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(ValueError, "checked-out HEAD"):
                image_build.build("newsletter", "a" * 40)
            self.assertEqual(read.call_count, 1)
            run.assert_not_called()

    def test_a_loaded_image_with_another_revision_is_never_promoted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".bazelversion").write_text("9.3.1\n")
            (root / "config").mkdir()
            (root / "config/cloud.toml").write_text('repository = "fixture/example"\n')
            (root / "image.tar").touch()
            loaded = {
                "id": "sha256:" + "c" * 64,
                "revision": "b" * 40,
                "source": "https://github.com/fixture/example",
            }
            with (
                patch.object(image_build, "ROOT", root),
                patch.object(
                    image_build.subprocess,
                    "check_output",
                    side_effect=[
                        "a" * 40 + "\n",
                        "bazel 9.3.1\n",
                        "image.tar\n",
                        json.dumps(loaded),
                    ],
                ),
                patch.object(image_build.subprocess, "run") as run,
            ):
                with self.assertRaisesRegex(ValueError, "identity does not match"):
                    image_build.build("newsletter", "a" * 40)
                self.assertFalse(
                    any(
                        call.args[0][:2] == ["docker", "tag"]
                        for call in run.call_args_list
                    )
                )

    def test_matching_checkout_and_loaded_image_tags_and_returns_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".bazelversion").write_text("9.3.1\n")
            (root / "config").mkdir()
            (root / "config/cloud.toml").write_text('repository = "fixture/example"\n')
            (root / "image.tar").write_bytes(b"archive-bytes")
            sha = "a" * 40
            image_id = "sha256:" + "c" * 64
            loaded = {
                "id": image_id,
                "revision": sha,
                "source": "https://github.com/fixture/example",
            }
            with (
                patch.object(image_build, "ROOT", root),
                patch.object(
                    image_build.subprocess,
                    "check_output",
                    side_effect=[
                        sha + "\n",
                        "bazel 9.3.1\n",
                        "image.tar\n",
                        json.dumps(loaded),
                    ],
                ),
                patch.object(image_build.subprocess, "run") as run,
            ):
                result = image_build.build("newsletter", sha)
            self.assertEqual(
                result,
                {
                    "source_sha": sha,
                    "service": "newsletter",
                    "image_id": image_id,
                    "tag": f"newsletter-ci:{sha}",
                },
            )
            self.assertEqual(
                run.call_args_list[-1].args[0],
                ["docker", "tag", image_id, f"newsletter-ci:{sha}"],
            )


class ImageReleaseTests(unittest.TestCase):
    def test_inspect_and_registry_digest_validate_docker_outputs(self):
        image_id = "sha256:" + "d" * 64
        with patch.object(
            image_release.subprocess, "check_output", return_value=image_id + "\n"
        ):
            self.assertEqual(image_release.inspect("newsletter:ci"), image_id)
        with patch.object(
            image_release.subprocess, "check_output", return_value="not-a-digest\n"
        ):
            with self.assertRaisesRegex(ValueError, "Invalid tested image ID"):
                image_release.inspect("newsletter:ci")

        repo = "ghcr.io/fixture/example-newsletter"
        pinned = f"{repo}@sha256:" + "e" * 64
        with patch.object(
            image_release.subprocess,
            "check_output",
            return_value=json.dumps([pinned, "other/repo@sha256:" + "f" * 64]),
        ):
            self.assertEqual(
                image_release.registry_digest(f"{repo}:service", repo), pinned
            )
        for bad_list in ([], [pinned, f"{repo}@sha256:" + "1" * 64]):
            with (
                self.subTest(digests=bad_list),
                patch.object(
                    image_release.subprocess,
                    "check_output",
                    return_value=json.dumps(bad_list),
                ),
                self.assertRaisesRegex(
                    ValueError, "Published registry digest is unavailable or ambiguous"
                ),
            ):
                image_release.registry_digest(f"{repo}:service", repo)

    def test_save_verify_and_publish_enforce_manifest_and_checksum_integrity(self):
        sha = "a" * 40
        image_id = "sha256:" + "b" * 64
        repo = "ghcr.io/fixture/example-newsletter"
        pinned = f"{repo}@sha256:" + "c" * 64
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact_dir = root / "artifact"

            def fake_docker_run(cmd, check=False):
                if cmd[:3] == ["docker", "save", "--output"]:
                    Path(cmd[3]).write_bytes(b"tested-tar-stream")

            with (
                patch.object(
                    image_release.subprocess,
                    "check_output",
                    return_value=image_id + "\n",
                ),
                patch.object(
                    image_release.subprocess, "run", side_effect=fake_docker_run
                ),
            ):
                image_release.save("newsletter-ci:" + sha, sha, artifact_dir)

            manifest = image_release.verify(sha, artifact_dir)
            self.assertEqual(manifest["sha"], sha)
            self.assertEqual(manifest["image_id"], image_id)

            with self.assertRaisesRegex(ValueError, "identity or checksum mismatch"):
                image_release.verify("f" * 40, artifact_dir)

            (artifact_dir / "image.tar").write_bytes(b"tampered-tar-stream")
            with self.assertRaisesRegex(ValueError, "identity or checksum mismatch"):
                image_release.verify(sha, artifact_dir)

            (artifact_dir / "image.tar").write_bytes(b"tested-tar-stream")
            with (
                patch.object(
                    image_release.subprocess,
                    "check_output",
                    side_effect=[image_id + "\n", json.dumps([pinned])],
                ),
                patch.object(image_release.subprocess, "run") as run,
                redirect_stdout(io.StringIO()),
            ):
                receipt = image_release.publish(sha, artifact_dir, repo)
            self.assertEqual(
                receipt,
                {
                    "source_sha": sha,
                    "tested_image_id": image_id,
                    "image": pinned,
                },
            )
            self.assertEqual(len(run.call_args_list), 5)

            with (
                patch.object(
                    image_release.subprocess,
                    "check_output",
                    return_value="sha256:" + "9" * 64 + "\n",
                ),
                patch.object(image_release.subprocess, "run"),
            ):
                with self.assertRaisesRegex(
                    ValueError, "Loaded image differs from the tested image"
                ):
                    image_release.publish(sha, artifact_dir, repo)

            oversized = root / "oversized"
            oversized.mkdir()
            (oversized / "image.tar").write_bytes(b"x")
            (oversized / "manifest.json").write_text(" " * 2049)
            with self.assertRaisesRegex(ValueError, "Invalid release manifest"):
                image_release.verify(sha, oversized)

            symlink_dir = root / "symlink-dir"
            symlink_dir.symlink_to(artifact_dir)
            with self.assertRaisesRegex(ValueError, "missing or unsafe"):
                image_release.verify(sha, symlink_dir)

    def test_main_save_and_publish_cli_branches(self):
        sha = "a" * 40
        image_id = "sha256:" + "b" * 64
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact_dir = root / "saved"
            receipt_file = root / "receipt.json"
            gh_out = root / "github_output.txt"

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "image.py",
                        "save",
                        "--sha",
                        "bad-sha",
                        "--directory",
                        str(artifact_dir),
                    ],
                ),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                image_release.main()

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "image.py",
                        "save",
                        "--sha",
                        sha,
                        "--directory",
                        str(artifact_dir),
                    ],
                ),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                image_release.main()

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "image.py",
                        "save",
                        "--sha",
                        sha,
                        "--directory",
                        str(artifact_dir),
                        "--image",
                        "newsletter-ci:" + sha,
                    ],
                ),
                patch.object(image_release, "save") as mock_save,
            ):
                image_release.main()
                mock_save.assert_called_once_with(
                    "newsletter-ci:" + sha, sha, artifact_dir
                )

            fake_receipt = {
                "source_sha": sha,
                "tested_image_id": image_id,
                "image": "ghcr.io/ziyixi/todofy-platform@sha256:" + "e" * 64,
            }
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "image.py",
                        "publish",
                        "--sha",
                        sha,
                        "--directory",
                        str(artifact_dir),
                        "--service",
                        "platform",
                        "--receipt",
                        str(receipt_file),
                        "--github-output",
                    ],
                ),
                patch.object(
                    image_release, "publish", return_value=fake_receipt
                ) as mock_publish,
                patch.dict(os.environ, {"GITHUB_OUTPUT": str(gh_out)}, clear=False),
            ):
                image_release.main()
                mock_publish.assert_called_once()
                self.assertEqual(
                    json.loads(receipt_file.read_text()), fake_receipt
                )
                self.assertEqual(
                    gh_out.read_text(), f"image={fake_receipt['image']}\n"
                )

            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "image.py",
                        "publish",
                        "--sha",
                        sha,
                        "--directory",
                        str(artifact_dir),
                        "--github-output",
                    ],
                ),
                patch.object(image_release, "publish", return_value=fake_receipt),
                patch.dict(os.environ, {}, clear=True),
                self.assertRaisesRegex(ValueError, "Missing Actions output file"),
            ):
                image_release.main()
