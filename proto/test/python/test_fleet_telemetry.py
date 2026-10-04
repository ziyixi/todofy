"""Legacy required daemon keys and optional configured observations remain compatible."""

import copy
import json
import unittest

from proto_test_support import REPO
from ziyixi_proto.fleet.telemetry.v1.host_report_pb import HostReport, SystemDaemonSnapshot
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire


class FleetTelemetry(unittest.TestCase):
    def fixture(self):
        return json.loads((REPO / "contracts/fleet-report-v1/fixtures/healthy.json").read_text())

    def test_legacy_report_and_snapshot_round_trip_without_configured_map(self):
        report = self.fixture()
        self.assertEqual(to_wire(from_wire(HostReport, report, strict=True).message), report)
        snapshot = {"observation_time": report["observation_time"], "daemons": report["daemons"]}
        self.assertEqual(to_wire(from_wire(SystemDaemonSnapshot, snapshot, strict=True).message), snapshot)

    def test_new_report_observes_configured_daemons_and_keeps_unconfigured_legacy_alias_unknown(self):
        report = self.fixture()
        report["configured_daemons"] = {name: report["daemons"][name] for name in ("k3s", "ssh")}
        report["configured_daemons"]["cloudflared_platform"] = {"state": "active"}
        report["daemons"] = {**report["configured_daemons"], "cloudflared": {"state": "unknown"}}
        self.assertEqual(to_wire(from_wire(HostReport, report, strict=True).message), report)

    def test_legacy_required_key_and_new_alias_bounds_are_not_weakened(self):
        report = self.fixture()
        del report["daemons"]["cloudflared"]
        with self.assertRaises(WireJsonError):
            from_wire(HostReport, report, strict=True)
        invalid = copy.deepcopy(self.fixture())
        invalid["configured_daemons"] = {"private_unit": {"state": "active"}}
        with self.assertRaises(WireJsonError):
            from_wire(HostReport, invalid, strict=True)


if __name__ == "__main__":
    unittest.main()
