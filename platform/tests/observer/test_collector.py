"""Optional inventory must survive unavailable metrics and never displace the heartbeat."""

from __future__ import annotations

import json
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from personal_cloud.observer import collector
from ziyixi_proto.fleet.telemetry.v1.host_report_pb import HostReport
from ziyixi_proto.wire_json import from_wire, to_wire

INVENTORY = {
    "state": "observed",
    "workloads": [
        {
            "workload_key": "new-service",
            "state": "ready",
            "desired_count": 1,
            "ready_count": 1,
            "restart_count": 0,
            "readiness_probe": True,
        }
    ],
}


class CollectorInventoryTests(unittest.TestCase):
    def observe(self, inventory=INVENTORY, *, encode=None, metrics=None):
        with ExitStack() as stack:
            stack.enter_context(
                patch.multiple(
                    collector,
                    kube=lambda env: {"state": "unknown"},
                    resource_percentages=lambda: (None, None),
                    systemd_snapshot=dict,
                    configured_daemons=lambda env: (),
                    newsletter=lambda env: {
                        "state": "unknown",
                        "drain_state": "unknown",
                    },
                    runtime_status=lambda env: None,
                    source_sha=lambda: None,
                    node_metrics=lambda namespace, pods: metrics,
                    discover=lambda namespace: (inventory, []),
                )
            )
            if encode is not None:
                stack.enter_context(
                    patch.object(collector, "_encode", side_effect=encode)
                )
            data = collector.observe({}, 1)
        self.assertLessEqual(len(data), 16_384)
        return json.loads(data)

    def test_inventory_is_independent_of_unavailable_metrics_and_release_provenance(
        self,
    ):
        report = self.observe()
        self.assertEqual(report["workload_inventory"], INVENTORY)
        self.assertNotIn("metrics", report)
        self.assertIsNone(report["runtime"])
        invalid = {"state": "observed", "workloads": [{"workload_key": "Bad/Key"}]}
        self.assertEqual(
            self.observe(invalid)["workload_inventory"],
            {"state": "unavailable"},
        )

    def test_budget_first_marks_inventory_truncated_then_omits_it(self):
        real = collector._encode
        for predicate, expected in (
            (
                lambda value: bool(
                    value.get("workload_inventory", {}).get("workloads")
                ),
                {"state": "truncated"},
            ),
            (lambda value: "workload_inventory" in value, None),
        ):

            def encode(value, predicate=predicate):
                return real(value) + (b" " * 16_384 if predicate(value) else b"")

            report = self.observe(encode=encode)
            self.assertEqual(report.get("workload_inventory"), expected)
            self.assertEqual(report["version"], "fleet-report-v1")

    def test_legacy_report_without_inventory_still_decodes(self):
        path = (
            Path(__file__).resolve().parents[3]
            / "contracts/fleet-report-v1/fixtures/healthy.json"
        )
        legacy = json.loads(path.read_text())
        self.assertNotIn("workload_inventory", legacy)
        self.assertIsNone(
            to_wire(from_wire(HostReport, legacy, strict=True).message).get(
                "workload_inventory"
            )
        )

    def test_new_inventory_exceeding_budget_preserves_existing_metrics(self):
        path = (
            Path(__file__).resolve().parents[3]
            / "contracts/fleet-report-v1/fixtures/node_metrics.json"
        )
        metrics = json.loads(path.read_text())["metrics"]
        real = collector._encode

        def encode(value):
            inventory_has_rows = bool(
                value.get("workload_inventory", {}).get("workloads")
            )
            return real(value) + (b" " * 16_384 if inventory_has_rows else b"")

        report = self.observe(encode=encode, metrics=metrics)
        self.assertEqual(report["metrics"], metrics)
        self.assertEqual(report["workload_inventory"], {"state": "truncated"})


if __name__ == "__main__":
    unittest.main()
