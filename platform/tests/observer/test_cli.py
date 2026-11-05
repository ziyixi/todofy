"""Standard Pod termination metadata distinguishes unread and invalid snapshots."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from personal_cloud import __main__ as entrypoint
from personal_cloud.observer import cli
from personal_cloud.observer import systemd_snapshot as snapshot
from personal_cloud.observer.transport import ObserverError


class CliTests(unittest.TestCase):
    def test_fresh_observation_records_successful_snapshot_read(self):
        with tempfile.TemporaryDirectory() as directory:
            termination = Path(directory) / "termination"
            path = Path(directory) / "snapshot.json"
            with (
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(snapshot, "daemon", return_value={"state": "active"}),
                patch.object(cli, "run", side_effect=lambda _env: snapshot.read()),
                patch.dict(cli.os.environ, {}, clear=True),
                patch.object(snapshot, "TERMINATION_PATH", termination),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                snapshot.write()
                self.assertEqual(cli.main(), 0)
            self.assertEqual(
                json.loads(termination.read_bytes())["snapshot"], "READ_OK"
            )

    def test_unwritable_termination_file_does_not_interrupt_accepted_receipt(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(cli, "run") as run,
            patch.dict(cli.os.environ, {}, clear=True),
            patch.object(
                snapshot, "TERMINATION_PATH", Path(directory) / "absent" / "file"
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(cli.main(), 0)
            run.assert_called_once_with({})

    def test_successful_pending_receipt_does_not_claim_to_have_read_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            termination = Path(directory) / "termination"
            with (
                patch.object(cli, "run"),
                patch.dict(cli.os.environ, {}, clear=True),
                patch.object(snapshot, "TERMINATION_PATH", termination),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(cli.main(), 0)
            self.assertEqual(
                json.loads(termination.read_bytes()),
                {
                    "version": 1,
                    "code": "OBSERVER_ACCEPTED",
                    "snapshot": "NOT_READ",
                },
            )

    def test_failed_report_preserves_snapshot_classification_without_error_text(self):
        with tempfile.TemporaryDirectory() as directory:
            termination = Path(directory) / "termination"
            path = Path(directory) / "snapshot.json"
            path.write_bytes(b"private invalid fixture")

            def fail(_env):
                snapshot.read()
                raise ObserverError("private provider response")

            output = io.StringIO()
            with (
                patch.object(cli, "run", side_effect=fail),
                patch.dict(cli.os.environ, {}, clear=True),
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(snapshot, "TERMINATION_PATH", termination),
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(cli.main(), 1)
            self.assertEqual(
                json.loads(termination.read_bytes()),
                {
                    "version": 1,
                    "code": "OBSERVER_FAILED",
                    "snapshot": "INVALID",
                },
            )
            self.assertNotIn("private", output.getvalue() + termination.read_text())

    def test_entrypoint_dispatches_all_subcommands_and_rejects_unknown_command(self):
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["personal-cloud", "identity"]),
            patch(
                "personal_cloud.status_daemon.adapters.baked_source_sha",
                return_value="a" * 40,
            ),
            contextlib.redirect_stdout(output),
        ):
            self.assertEqual(entrypoint.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"source_sha": "a" * 40})
        with (
            patch.object(sys, "argv", ["personal-cloud", "identity"]),
            patch(
                "personal_cloud.status_daemon.adapters.baked_source_sha",
                return_value=None,
            ),
        ):
            self.assertEqual(entrypoint.main(), 1)
        for command, target, expected in (
            ("observer", "personal_cloud.observer.cli.main", 0),
            ("observer-systemd", "personal_cloud.observer.systemd_snapshot.main", 0),
            ("status-daemon", "personal_cloud.status_daemon.server.main", 0),
        ):
            with (
                self.subTest(command=command),
                patch.object(sys, "argv", ["personal-cloud", command]),
                patch(target, return_value=expected) as run,
            ):
                self.assertEqual(entrypoint.main(), expected)
                run.assert_called_once_with()
        with (
            patch.object(sys, "argv", ["personal-cloud", "unknown"]),
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as exited,
        ):
            entrypoint.main()
        self.assertEqual(exited.exception.code, 2)
