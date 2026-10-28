"""Legacy required daemon keys and optional configured observations remain compatible."""

import copy
import json
import unittest

from proto_test_support import REPO
from ziyixi_proto.fleet.telemetry.v1.host_report_pb import HostReport, SystemDaemonSnapshot
from ziyixi_proto.wire_json import WireJsonError, from_wire, to_wire


class FleetTelemetry(unittest.TestCase):
    def fixture(self, name="healthy"):
        return json.loads((REPO / f"contracts/fleet-report-v1/fixtures/{name}.json").read_text())

    def test_node_metrics_round_trip_and_stay_optional(self):
        report = self.fixture("node_metrics")
        self.assertEqual(to_wire(from_wire(HostReport, report, strict=True).message), report)
        del report["metrics"]
        self.assertEqual(to_wire(from_wire(HostReport, report, strict=True).message), report)
        partial = self.fixture("node_metrics")
        partial["metrics"] = {key: partial["metrics"][key] for key in ("boot_id", "uptime_seconds")}
        self.assertEqual(to_wire(from_wire(HostReport, partial, strict=True).message), partial)

    def test_node_metrics_refuse_names_unbounded_lists_and_impossible_values(self):
        def invalid(change):
            report = self.fixture("node_metrics")
            change(report["metrics"])
            with self.assertRaises(WireJsonError):
                from_wire(HostReport, report, strict=True)

        invalid(lambda metrics: metrics.update(boot_id="not-a-boot"))
        invalid(lambda metrics: metrics.update(interface="enp1s0"))
        invalid(lambda metrics: metrics["network"].update(name="enp1s0"))
        invalid(lambda metrics: metrics["cpu"].update(idle_milliseconds=-1))
        invalid(lambda metrics: metrics["cpu"].update(total_milliseconds=2**53))
        invalid(lambda metrics: metrics["cpu"].pop("cpu_count"))
        invalid(lambda metrics: metrics["filesystems"].update({"/var/lib": metrics["filesystems"]["root"]}))
        invalid(lambda metrics: metrics["workloads"][0].update(workload_key="Pod/name"))
        invalid(lambda metrics: metrics.update(workloads=metrics["workloads"] * 6))

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
