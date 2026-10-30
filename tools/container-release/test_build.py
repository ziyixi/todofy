"""Promotion starts only from the actual checkout and a matching loaded image."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build as image_build


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
