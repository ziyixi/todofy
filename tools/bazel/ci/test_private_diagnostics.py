"""Synthetic private output cannot carry messages, identities or counts into public logs."""

import json
import tempfile
import unittest
from pathlib import Path

import private_diagnostics as diagnostics


def event(**changes):
    return {
        "event": "private_ingress_collector_logs_probe",
        "phase": "verification",
        "available": True,
        "current": {
            "available": True,
            "line_count": 17,
            "codes": {"STORAGE_RECOVERY_REQUIRED": 1},
            "exception_classes": {"duckdb_memory": 1},
            "durable_failures": {"causes": {"local_io": 1}},
            "traceback_count": 1,
        },
        "previous": {"available": False},
        **changes,
    }


class PrivateDiagnosticsTests(unittest.TestCase):
    def project(self, content):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private.log"
            path.write_bytes(content)
            return diagnostics.project(path)

    def test_phase_and_log_generation_remain_separate_and_deduplicated(self):
        before, current = event(phase="before_rollout"), event()
        before["previous"] = before["current"]
        result = self.project(
            (
                json.dumps(before)
                + "\n"
                + json.dumps(current)
                + "\n"
                + json.dumps(current)
            ).encode()
        )
        expected = {
            (phase, tail, code)
            for phase, tail in (
                ("BEFORE_ROLLOUT", "ACTIVE_LOG"),
                ("BEFORE_ROLLOUT", "PRIOR_LOG"),
                ("VERIFICATION", "ACTIVE_LOG"),
            )
            for code in (
                "DATABASE_MEMORY",
                "LOCAL_IO",
                "RECOVERY_REQUIRED",
                "TRACEBACK_PRESENT",
            )
        }
        self.assertEqual(result, expected)

    def test_unknown_fields_and_exception_messages_never_leave_the_boundary(self):
        value = event(
            secret="secret-canary https://private.invalid SELECT * FROM secret"
        )
        value["current"]["exception_classes"]["secret-canary"] = 1
        value["current"]["codes"]["secret-canary"] = 1
        self.assertEqual(
            diagnostics.observations(value), diagnostics.observations(event())
        )
        for changes in (
            {"phase": "secret-canary"},
            {"phase": []},
            {"event": "secret-canary"},
            {"available": 1},
            {"current": "secret-canary"},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(
                    self.project((json.dumps(event(**changes)) + "\n").encode())
                )

    def test_boolean_unbounded_and_wrong_type_counts_are_rejected(self):
        for invalid in (True, False, -1, 18, 101, "1", None, {}, []):
            value = event()
            value["current"].update(
                exception_classes={"duckdb_memory": invalid},
                codes={"STORAGE_RECOVERY_REQUIRED": invalid},
                durable_failures={"causes": {"local_io": invalid}},
                traceback_count=invalid,
            )
            with self.subTest(invalid=invalid):
                self.assertFalse(diagnostics.observations(value))
        for invalid in (True, -1, 101, "17", None):
            value = event()
            value["current"]["line_count"] = invalid
            self.assertFalse(diagnostics.observations(value))

    def test_malformed_overlarge_and_partial_lines_do_not_hide_later_safe_observations(
        self,
    ):
        safe = json.dumps(event()).encode()
        content = b'{"event":\n\xff\n' + b"x" * 65537 + safe + b"\n" + safe + b"\n{"
        self.assertEqual(self.project(content), diagnostics.observations(event()))
        self.assertFalse(diagnostics.project("/missing/private-canary"))


if __name__ == "__main__":
    unittest.main()
