"""Explicit reader grants and completed maintenance-process cleanup."""

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/vps-bootstrap"))
import install
import reader
import repair
import repair_kube

from config import BootstrapError


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
                ) as reader,
                contextlib.redirect_stdout(io.StringIO()) as output,
            ):
                self.assertEqual(repair.main(), 0)
                recover.assert_called_once_with(Path("/old"), Path("/bundle"))
                if flag:
                    reader.assert_called_once_with("personal-cloud")
                    self.assertEqual(
                        json.loads(output.getvalue()),
                        {
                            "event": "namespace_reader",
                            "expires_at": "2027-10-03T00:00:00Z",
                        },
                    )
                else:
                    reader.assert_not_called()
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
            patch.object(repair, "install_reader") as reader,
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            self.assertEqual(repair.main(), 1)
            reader.assert_not_called()
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
