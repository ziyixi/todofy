"""Private catalogue materialization uses the selected gitlink and keeps private output on the runner."""

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import private_catalog
from workflow_sources import ROOT, workflow_data

SHA = "a" * 40


class PrivateCatalogue(unittest.TestCase):
    def test_revision_accepts_only_a_pinned_private_gitlink_without_echoing_invalid_data(
        self,
    ):
        for value, valid in (
            (f"160000 commit {SHA}\tprivate", True),
            ("", False),
            (f"040000 tree {SHA}\tprivate", False),
            ("synthetic-private-value", False),
        ):
            with patch.object(private_catalog, "git", return_value=value) as git:
                if valid:
                    self.assertEqual(private_catalog.revision("selected-source"), SHA)
                else:
                    with self.assertRaisesRegex(
                        ValueError, "^PRIVATE_CATALOG_SOURCE_INVALID$"
                    ):
                        private_catalog.revision("selected-source")
                git.assert_called_once_with(
                    "selected-source", "ls-tree", "HEAD", "private"
                )

    def test_git_failures_do_not_expose_provider_or_checkout_output(self):
        with patch.object(
            private_catalog.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                [], 1, "synthetic-private-value", "synthetic-path"
            ),
        ):
            with self.assertRaisesRegex(ValueError, "^PRIVATE_CATALOG_SOURCE_INVALID$"):
                private_catalog.git("selected-source", "rev-parse", "HEAD")

    def source(self, directory, script):
        root = Path(directory).resolve() / ".release-source"
        entry = root / "private/ci/release.py"
        entry.parent.mkdir(parents=True)
        entry.write_text(script)
        return root

    def pinned(self, root):
        def git(path, *arguments):
            if path == root / "private" and arguments == ("rev-parse", "HEAD"):
                return SHA
            if path == root and arguments == ("ls-tree", "HEAD", "private"):
                return f"160000 commit {SHA}\tprivate"
            self.fail("The catalogue did not use its selected source root")

        return patch.object(private_catalog, "git", side_effect=git)

    def test_selected_source_entry_writes_an_owner_only_file_without_public_output(
        self,
    ):
        script = (
            "import json, os, sys\n"
            "assert sys.argv[1:4] == ['--operation', 'catalog', '--output']\n"
            "print('synthetic-private-stdout')\n"
            "print('synthetic-private-stderr', file=sys.stderr)\n"
            "fd = os.open(sys.argv[4], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)\n"
            "with os.fdopen(fd, 'w') as handle: json.dump({'synthetic': True}, handle)\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = self.source(directory, script)
            output = Path(directory) / "catalogue.json"
            stdout, stderr = io.StringIO(), io.StringIO()
            with (
                self.pinned(root),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
            ):
                private_catalog.generate(root, output)
                self.assertEqual(json.loads(output.read_text()), {"synthetic": True})
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(
                    ValueError, "^PRIVATE_CATALOG_GENERATION_FAILED$"
                ):
                    private_catalog.generate(root, output)
            self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")

    def test_a_mismatched_private_checkout_is_refused_before_the_entry_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.source(directory, "raise Exception('synthetic-private-value')")
            output = Path(directory) / "catalogue.json"
            with patch.object(
                private_catalog,
                "git",
                side_effect=["b" * 40, f"160000 commit {SHA}\tprivate"],
            ):
                with self.assertRaisesRegex(
                    ValueError, "^PRIVATE_CATALOG_SOURCE_INVALID$"
                ):
                    private_catalog.generate(root, output)
            self.assertFalse(output.exists())

    def test_an_older_or_failed_entry_has_no_fallback_and_removes_partial_output(self):
        scripts = [
            "import sys\nprint('synthetic-private-error', file=sys.stderr)\nsys.exit(2)\n",
            "import os, sys\nfd = os.open(sys.argv[4], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)\nos.write(fd, b'synthetic-private-value')\nos.close(fd)\nsys.exit(1)\n",
        ]
        for script in scripts:
            with (
                self.subTest(script=script),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = self.source(directory, script)
                output = Path(directory) / "catalogue.json"
                stdout, stderr = io.StringIO(), io.StringIO()
                with (
                    self.pinned(root),
                    contextlib.redirect_stdout(stdout),
                    contextlib.redirect_stderr(stderr),
                ):
                    with self.assertRaisesRegex(
                        ValueError, "^PRIVATE_CATALOG_GENERATION_FAILED$"
                    ):
                        private_catalog.generate(root, output)
                self.assertFalse(output.exists())
                self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")

    def test_checkout_action_uses_only_the_existing_read_key_and_pinned_source(self):
        action = workflow_data(ROOT / ".github/actions/private-catalog/action.yml")
        sequence = action["runs"]["steps"]
        checkout = next(
            step
            for step in sequence
            if step.get("uses") == "./.github/actions/private-checkout"
        )
        self.assertEqual(
            checkout["with"],
            {
                "revision": "${{ steps.private_catalog_source.outputs.revision }}",
                "path": "${{ inputs.source-root }}/private",
                "ssh-key": "${{ inputs.private-ssh-key }}",
                "history": "commit",
            },
        )
        self.assertFalse(any(step.get("uses", "").startswith("actions/checkout@") for step in sequence))
        self.assertIn(
            'revision --source-root "$PRIVATE_CATALOG_SOURCE" >> "$GITHUB_OUTPUT"',
            sequence[0]["run"],
        )
        self.assertIn(
            'generate --source-root "$PRIVATE_CATALOG_SOURCE" --output "$PRIVATE_CATALOG_OUTPUT"',
            sequence[-1]["run"],
        )
        text = str(action)
        for forbidden in (
            "upload-artifact",
            "actions/cache",
            "secret set",
            "PRIVATE_CATALOG:",
            "GITHUB_TOKEN",
        ):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
