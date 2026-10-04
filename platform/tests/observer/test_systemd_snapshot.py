"""Real bounded wire snapshots with synthetic D-Bus observations and temporary storage."""

import contextlib
import datetime as dt
import io
import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from personal_cloud.observer import systemd_snapshot as snapshot
from personal_cloud.observer.transport import ObserverError
from ziyixi_proto.fleet.telemetry.v1.host_report_pb import SystemDaemonSnapshot
from ziyixi_proto.wire_json import from_wire, to_wire


class SnapshotTests(unittest.TestCase):
    def value(self, age=0):
        observed = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=age)
        return {
            "observation_time": observed.isoformat(timespec="seconds").replace(
                "+00:00", "Z"
            ),
            "daemons": {name: {"state": "active"} for name in snapshot.UNITS},
        }

    def unknown(self):
        return {name: {"state": "unknown"} for name in snapshot.UNITS}

    def test_init_snapshot_roundtrips_shared_proto_without_touching_other_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            durable = Path(directory) / "durable-state.json"
            durable.write_bytes(b"existing receipt bytes")
            with (
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(
                    snapshot, "daemon", return_value={"state": "active"}
                ) as daemon,
            ):
                snapshot.write()
                wire = json.loads(path.read_bytes())
                self.assertEqual(
                    to_wire(from_wire(SystemDaemonSnapshot, wire, strict=True).message),
                    wire,
                )
                self.assertEqual(snapshot.read(), wire["daemons"])
            self.assertEqual(
                [call.args[0] for call in daemon.call_args_list], list(snapshot.UNITS)
            )
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            self.assertEqual(durable.read_bytes(), b"existing receipt bytes")
            self.assertLessEqual(path.stat().st_size, snapshot.MAX_BYTES)
            self.assertFalse(list(Path(directory).glob(".snapshot-*")))

    def test_absent_optional_transport_remains_unknown(self):
        value = self.value()
        del value["daemons"]["cloudflared_platform"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text(json.dumps(value))
            with patch.object(snapshot, "SNAPSHOT_PATH", path):
                result = snapshot.read()
            self.assertEqual(result["k3s"], {"state": "active"})
            self.assertEqual(result["cloudflared_platform"], {"state": "unknown"})

    def test_fresh_host_observes_only_three_declared_daemons(self):
        aliases = ["k3s", "ssh", "cloudflared_platform"]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("os.environ", {"FLEET_EXPECTED_DAEMONS": json.dumps(aliases)}),
        ):
            path = Path(directory) / "snapshot.json"
            with (
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(
                    snapshot, "daemon", return_value={"state": "active"}
                ) as daemon,
            ):
                snapshot.write()
                self.assertEqual(set(snapshot.read()), set(aliases))
                self.assertEqual(
                    [call.args[0] for call in daemon.call_args_list], aliases
                )
            wire = json.loads(path.read_bytes())
            self.assertNotIn("cloudflared", wire["configured_daemons"])
            self.assertEqual(wire["daemons"]["cloudflared"], {"state": "unknown"})

    def test_legacy_snapshot_remains_readable_after_fresh_configuration(self):
        aliases = ["k3s", "ssh", "cloudflared_platform"]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("os.environ", {"FLEET_EXPECTED_DAEMONS": json.dumps(aliases)}),
        ):
            path = Path(directory) / "snapshot.json"
            path.write_text(json.dumps(self.value()))
            with patch.object(snapshot, "SNAPSHOT_PATH", path):
                self.assertEqual(
                    snapshot.read(), {name: {"state": "active"} for name in aliases}
                )

    def test_configured_snapshot_cannot_hide_missing_keys_or_disagree_with_legacy_state(
        self,
    ):
        values = []
        for daemons in (
            {},
            {"k3s": {"state": "active"}},
            {"k3s": {"state": "failed"}, "ssh": {"state": "active"}},
        ):
            values.append({**self.value(), "configured_daemons": daemons})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch.object(snapshot, "SNAPSHOT_PATH", path):
                for value in values:
                    with self.subTest(daemons=value["configured_daemons"]):
                        path.write_text(json.dumps(value))
                        self.assertEqual(snapshot.read(), self.unknown())
                        self.assertEqual(snapshot.READ_CODE, "INVALID")

    def test_stale_future_and_missing_observations_cannot_appear_current(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch.object(snapshot, "SNAPSHOT_PATH", path):
                self.assertEqual(snapshot.read(), self.unknown())
                self.assertEqual(snapshot.READ_CODE, "UNREADABLE")
                for age, expected in ((121, "STALE"), (-6, "FUTURE")):
                    with self.subTest(age=age):
                        path.write_text(json.dumps(self.value(age)))
                        self.assertEqual(snapshot.read(), self.unknown())
                        self.assertEqual(snapshot.READ_CODE, expected)

    def test_shared_contract_rejects_unknown_alias_state_and_private_fields(self):
        values = []
        for key, value in (
            ("private", {"state": "active"}),
            ("k3s", {"state": "ready"}),
        ):
            fixture = self.value()
            fixture["daemons"][key] = value
            values.append(fixture)
        required = self.value()
        del required["daemons"]["ssh"]
        values.extend((required, {**self.value(), "logs": "private"}, {"daemons": {}}))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch.object(snapshot, "SNAPSHOT_PATH", path):
                for value in values:
                    with self.subTest(value=value):
                        path.write_text(json.dumps(value))
                        self.assertEqual(snapshot.read(), self.unknown())
                        self.assertEqual(snapshot.READ_CODE, "INVALID")

    def test_oversized_duplicate_and_invalid_json_are_unknown(self):
        value = json.dumps(self.value())
        bad = (
            b" " * (snapshot.MAX_BYTES + 1),
            (value[:-1] + ',"observation_time":"2026-01-01T00:00:00Z"}').encode(),
            b"[]",
            b"\xff",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch.object(snapshot, "SNAPSHOT_PATH", path):
                for raw in bad:
                    with self.subTest(raw=raw[:32]):
                        path.write_bytes(raw)
                        self.assertEqual(snapshot.read(), self.unknown())

    def test_atomic_failure_preserves_old_snapshot_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            old = json.dumps(self.value()).encode()
            path.write_bytes(old)
            with (
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(snapshot, "daemon", return_value={"state": "active"}),
                patch.object(
                    snapshot.os, "replace", side_effect=OSError("synthetic failure")
                ),
                self.assertRaises(OSError),
            ):
                snapshot.write()
            self.assertEqual(path.read_bytes(), old)
            self.assertFalse(list(Path(directory).glob(".snapshot-*")))

    def test_unsafe_management_grant_stops_init_without_snapshot_or_private_output(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            output = io.StringIO()
            termination = Path(directory) / "termination"
            with (
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(snapshot, "TERMINATION_PATH", termination),
                patch.object(
                    snapshot,
                    "daemon",
                    side_effect=ObserverError("unsafe_system_bus_authorization"),
                ),
                contextlib.redirect_stdout(output),
            ):
                self.assertEqual(snapshot.main(), 1)
            self.assertFalse(path.exists())
            self.assertEqual(
                json.loads(termination.read_bytes())["code"], "SYSTEMD_FAILED"
            )
            self.assertEqual(
                json.loads(output.getvalue()),
                {
                    "event": "systemd_observer",
                    "status": "failed",
                    "code": "UNSAFE_SYSTEM_BUS_AUTHORIZATION",
                },
            )

    def test_successful_init_emits_only_bounded_fixed_unit_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            termination = Path(directory) / "termination"

            def active(name, *, diagnostic):
                diagnostic.update(
                    unit=name, state="active", stage="ACTIVE_STATE", code="OK"
                )
                return {"state": "active"}

            with (
                patch.object(snapshot, "SNAPSHOT_PATH", path),
                patch.object(snapshot, "TERMINATION_PATH", termination),
                patch.object(snapshot, "daemon", side_effect=active),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(snapshot.main(), 0)
                self.assertEqual(snapshot.read(), self.value()["daemons"])
                self.assertEqual(snapshot.READ_CODE, "READ_OK")
            value = json.loads(termination.read_bytes())
            self.assertEqual(value["code"], "SYSTEMD_COMPLETE")
            self.assertEqual(
                {unit["unit"] for unit in value["units"]}, set(snapshot.UNITS)
            )
            self.assertLessEqual(termination.stat().st_size, 1024)

    def test_termination_never_includes_untrusted_fields_or_unbounded_values(self):
        with tempfile.TemporaryDirectory() as directory:
            termination = Path(directory) / "termination"
            valid = {
                "unit": "k3s",
                "state": "active",
                "stage": "ACTIVE_STATE",
                "code": "OK",
            }
            with patch.object(snapshot, "TERMINATION_PATH", termination):
                snapshot.write_termination(
                    "SYSTEMD_COMPLETE",
                    units=[
                        valid,
                        {**valid, "body": "private fixture"},
                        {**valid, "code": "private fixture"},
                    ],
                    snapshot="private fixture",
                )
                value = json.loads(termination.read_bytes())
                self.assertEqual(value["units"], [valid])
                self.assertNotIn(b"private", termination.read_bytes())
                snapshot.write_termination("SYSTEMD_COMPLETE", units=[valid] * 30)
                self.assertLessEqual(termination.stat().st_size, 1024)
                self.assertEqual(
                    json.loads(termination.read_bytes())["code"], "DIAGNOSTIC_TOO_LARGE"
                )
            with patch.object(
                snapshot, "TERMINATION_PATH", Path(directory) / "absent" / "file"
            ):
                snapshot.write_termination("OBSERVER_FAILED", snapshot="NOT_READ")


if __name__ == "__main__":
    unittest.main()
