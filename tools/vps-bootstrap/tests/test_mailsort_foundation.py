"""Root extension is fixed to the runner foundation and CI-tested daemon image."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))
import mailsort_foundation as extension

from config import BootstrapError

SHA = "a" * 40
IMAGE = "ghcr.io/example/cloud-platform@sha256:" + "b" * 64


class MailsortFoundation(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        public = {
            "source_sha": SHA,
            "profile": {
                "namespace": "personal-cloud",
                "state_root": str(root / "state"),
                "repository": "example/cloud",
            },
            "images": {
                "platform": IMAGE,
                "mailsort-runner": "ghcr.io/example/cloud-mailsort-runner@sha256:"
                + "c" * 64,
            },
        }
        foundation = [
            {"kind": kind, "metadata": {"name": name}}
            for kind, name in (
                ("PersistentVolume", "personal-cloud-mailsort-runner-auth"),
                ("PersistentVolumeClaim", "mailsort-runner-auth"),
                ("Role", "platform-controller"),
                ("PersistentVolumeClaim", "newsletter-data"),
            )
        ]
        (root / "foundation.json").write_text(json.dumps({"items": foundation}))
        platform = {
            "kind": "Deployment",
            "metadata": {"name": "platform-runtime"},
            "spec": {"template": {"spec": {"containers": [{"image": IMAGE}]}}},
        }
        (root / "runtime.json").write_text(
            json.dumps(
                {
                    "items": [
                        platform,
                        {"kind": "Deployment", "metadata": {"name": "newsletter"}},
                    ]
                }
            )
        )
        token, auth = root / "token", root / "auth.json"
        token.write_text("synthetic-token-" + "d" * 40)
        auth.write_text('{"tokens":{"synthetic":true}}')
        token.chmod(0o600)
        auth.chmod(0o600)
        return root, public, token, auth

    def test_installs_only_fixed_resources_and_keeps_private_values_off_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            root, public, token, auth = self.fixture(directory)
            with (
                patch.object(extension.os, "geteuid", return_value=0),
                patch.object(extension, "load_bundle", return_value=public),
                patch.object(extension, "directory"),
                patch.object(extension, "write_file") as write,
                patch.object(extension.cluster, "apply") as apply,
                patch.object(extension.cluster, "kubectl") as kubectl,
            ):
                extension.install(root, SHA, token, auth)
            items = apply.call_args_list[0].args[0]["items"]
            self.assertEqual(
                {item["metadata"]["name"] for item in items},
                {
                    "personal-cloud-mailsort-runner-auth",
                    "mailsort-runner-auth",
                    "platform-controller",
                    "mailsort-runner",
                },
            )
            self.assertEqual(
                apply.call_args_list[1].args[0]["metadata"]["name"], "platform-runtime"
            )
            self.assertEqual(
                write.call_args.kwargs, {"uid": 10001, "gid": 10001, "mode": 0o600}
            )
            self.assertNotIn(token.read_text(), str(kubectl.call_args))
            self.assertFalse(any(item["kind"] == "Job" for item in items))

    def test_nonroot_wrong_source_and_public_private_files_fail_before_cluster_write(
        self,
    ):
        for change in ("nonroot", "source", "public-token"):
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as directory,
            ):
                root, public, token, auth = self.fixture(directory)
                if change == "public-token":
                    token.chmod(0o644)
                with (
                    patch.object(
                        extension.os,
                        "geteuid",
                        return_value=1000 if change == "nonroot" else 0,
                    ),
                    patch.object(extension, "load_bundle", return_value=public),
                    patch.object(extension.cluster, "apply") as apply,
                    patch.object(extension, "directory") as mkdir,
                    self.assertRaises(BootstrapError),
                ):
                    extension.install(
                        root, "b" * 40 if change == "source" else SHA, token, auth
                    )
                apply.assert_not_called()
                mkdir.assert_not_called()
