"""Synthetic node readings: parsing, bounds and the metrics API; never the real host or cluster."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from personal_cloud.observer import collector, metrics
from personal_cloud.observer.transport import ObserverError
from ziyixi_proto.fleet.telemetry.v1.host_report_pb import NodeMetrics
from ziyixi_proto.wire_json import from_wire, to_wire

STAT = """cpu  1000 20 300 50000 400 0 30 0 0 0
cpu0 250 5 75 12500 100 0 8 0 0 0
cpu1 250 5 75 12500 100 0 7 0 0 0
intr 123 0 0
ctxt 456
"""
NET_DEV = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 900 9 0 0 0 0 0 0 900 9 0 0 0 0 0 0
enp1s0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
  wlo1: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
docker0: 111 1 0 0 0 0 0 0 222 2 0 0 0 0 0 0
  cni0: 333 3 0 0 0 0 0 0 444 4 0 0 0 0 0 0
veth1a2b3c4d: 555 5 0 0 0 0 0 0 666 6 0 0 0 0 0 0
flannel.1: 777 7 0 0 0 0 0 0 888 8 0 0 0 0 0 0
"""
MEMINFO = """MemTotal:       16000000 kB
MemFree:         1000000 kB
MemAvailable:    9000000 kB
SwapTotal:       4000000 kB
SwapFree:        3000000 kB
"""
BOOT = "5f0c8a52-7d1e-4b8a-9c3f-2a6b1d4e8f70"


def pod(labels, *containers):
    return {
        "metadata": {"name": "private-pod-name-7f9c", "labels": labels},
        "containers": [
            {"name": "main", "usage": {"cpu": cpu, "memory": memory}}
            for cpu, memory in containers
        ],
    }


class KernelFiles(unittest.TestCase):
    def test_cpu_times_sum_every_state_and_count_cpus_in_milliseconds(self):
        self.assertEqual(
            metrics.cpu_times(STAT, 100),
            {
                "cpu_count": 2,
                "total_milliseconds": 517_500,
                "idle_milliseconds": 500_000,
                "iowait_milliseconds": 4_000,
            },
        )

    def test_cpu_block_must_end_inside_the_bounded_prefix(self):
        truncated = "cpu  1 2 3 4 5 6 7 8\n" + "cpu0 1 2 3 4 5 6 7 8\n" * 3
        self.assertIsNone(metrics.cpu_times(truncated, 100))
        self.assertIsNone(metrics.cpu_times(truncated + "cpu1 1 2", 100))
        self.assertIsNone(metrics.cpu_times("intr 1\n", 100))
        self.assertIsNone(metrics.cpu_times("cpu  x 2 3 4 5 6 7 8\nintr 1\n", 100))
        self.assertIsNone(metrics.cpu_times(STAT, 0))
        self.assertIsNone(metrics.cpu_times(None, 100))

    def test_long_files_are_refused_or_cut_to_their_needed_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stat"
            path.write_text(STAT + "x" * metrics.MAX_FILE_BYTES)
            self.assertIsNone(metrics._read(path))
            self.assertEqual(
                metrics.cpu_times(metrics._read(path, prefix=True), 100)["cpu_count"], 2
            )
            self.assertIsNone(metrics._read(Path(directory) / "missing"))

    def test_load_and_memory(self):
        self.assertEqual(
            metrics.load_average("0.42 0.50 0.48 2/839 12345\n"),
            {"one_minute": 0.42, "five_minutes": 0.5, "fifteen_minutes": 0.48},
        )
        self.assertIsNone(metrics.load_average("nan 1 1"))
        self.assertIsNone(metrics.load_average(""))
        self.assertEqual(
            metrics.memory(MEMINFO),
            {
                "total_bytes": 16_384_000_000,
                "available_bytes": 9_216_000_000,
                "swap_total_bytes": 4_096_000_000,
                "swap_free_bytes": 3_072_000_000,
            },
        )
        self.assertIsNone(metrics.memory(MEMINFO.replace("SwapFree", "Other")))
        self.assertIsNone(metrics.memory(MEMINFO.replace("9000000", "17000000")))

    def test_network_sums_only_physical_interfaces_and_never_names_them(self):
        value = metrics.network(NET_DEV)
        self.assertEqual(
            value, {"interface_count": 2, "receive_bytes": 5000, "transmit_bytes": 7000}
        )
        self.assertNotIn("wlo1", json.dumps(value))
        self.assertIsNone(metrics.network("garbage"))
        self.assertIsNone(metrics.network(NET_DEV + "eth0: 1 2 3\n"))
        many = NET_DEV.splitlines()[:2] + [f"veth{i}: " + "0 " * 16 for i in range(600)]
        self.assertIsNone(metrics.network("\n".join(many)))

    def test_filesystem_reports_bytes_from_statvfs(self):
        with tempfile.TemporaryDirectory() as directory:
            value = metrics.filesystem(Path(directory))
            self.assertGreater(value["size_bytes"], 0)
            self.assertLessEqual(
                value["used_bytes"] + value["available_bytes"], value["size_bytes"]
            )
        self.assertIsNone(metrics.filesystem(Path("/nonexistent-observer-mount")))


class Workloads(unittest.TestCase):
    def test_quantities(self):
        self.assertAlmostEqual(metrics.cpu_cores("1500000n"), 0.0015)
        self.assertAlmostEqual(metrics.cpu_cores("250m"), 0.25)
        self.assertEqual(metrics.cpu_cores("2"), 2)
        self.assertEqual(metrics.memory_bytes("1024Ki"), 1_048_576)
        self.assertEqual(metrics.memory_bytes("3M"), 3_000_000)
        for invalid in ("1e3", "-1", "1.5Mi", None, 7, "12Pi"):
            self.assertIsNone(metrics.memory_bytes(invalid))
        self.assertIsNone(metrics.cpu_cores("1.5"))

    def test_usage_sums_by_workload_and_cronjob_without_pod_names(self):
        value = {
            "items": [
                pod({"app": "newsletter"}, ("1000000n", "100Mi"), ("500000n", "28Mi")),
                pod({"app": "newsletter"}, ("1m", "1Mi")),
                pod(
                    {"batch.kubernetes.io/job-name": "newsletter-daily-29885160"},
                    ("20m", "64Mi"),
                ),
                pod({"other": "x"}, ("5m", "1Mi")),
                pod({"app": "Bad/Key"}, ("5m", "1Mi")),
            ]
        }
        usage = metrics.workload_usage(value)
        self.assertEqual(
            usage,
            [
                {
                    "workload_key": "newsletter",
                    "cpu_cores": 0.0025,
                    "memory_bytes": 135266304,
                },
                {
                    "workload_key": "newsletter-daily",
                    "cpu_cores": 0.02,
                    "memory_bytes": 67108864,
                },
            ],
        )
        self.assertNotIn("private-pod-name", json.dumps(usage))

    def test_usage_is_bounded_and_one_malformed_item_discards_the_reading(self):
        many = {
            "items": [
                pod({"app": f"app-{index:02d}"}, ("1m", f"{index + 1}Mi"))
                for index in range(20)
            ]
        }
        usage = metrics.workload_usage(many)
        self.assertEqual(len(usage), metrics.MAX_WORKLOADS)
        self.assertNotIn("app-00", [item["workload_key"] for item in usage])
        self.assertEqual(usage, sorted(usage, key=lambda item: item["workload_key"]))
        self.assertEqual(metrics.workload_usage({"items": [{"metadata": {}}]}), [])
        broken = pod({"app": "newsletter"}, ("1m", "lots"))
        self.assertEqual(metrics.workload_usage({"items": [broken]}), [])
        self.assertEqual(metrics.workload_usage({"items": [{}] * 65}), [])
        self.assertEqual(metrics.workload_usage(None), [])

    def test_metrics_api_is_namespaced_bounded_and_unavailable_is_empty(self):
        with (
            patch.object(metrics.sdk, "ApiClient") as api,
            patch.object(metrics.MetricsClient, "_configuration"),
        ):
            api.return_value.call_api.return_value = {"items": []}
            self.assertEqual(metrics.workloads("personal-cloud"), [])
            call = api.return_value.call_api.call_args
            self.assertEqual(
                call.args,
                ("/apis/metrics.k8s.io/v1beta1/namespaces/{namespace}/pods", "GET"),
            )
            self.assertEqual(
                call.kwargs["path_params"], {"namespace": "personal-cloud"}
            )
            self.assertEqual(call.kwargs["query_params"], [("limit", 64)])
            api.return_value.call_api.side_effect = metrics.ApiException(status=403)
            self.assertEqual(metrics.workloads("personal-cloud"), [])
            api.return_value.close.assert_called()


class NodeReport(unittest.TestCase):
    def files(self, directory, **overrides):
        root = Path(directory)
        contents = {
            "sys/kernel/random/boot_id": BOOT + "\n",
            "uptime": "86400.25 300000.00\n",
            "stat": STAT,
            "loadavg": "0.42 0.50 0.48 2/839 12345\n",
            **overrides,
        }
        for name, text in contents.items():
            if text is not None:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(text)
        (root / "meminfo").write_text(MEMINFO)
        (root / "net-dev").write_text(NET_DEV)
        return patch.multiple(
            metrics,
            PROC=root,
            HOST_MEMINFO=root / "meminfo",
            HOST_NET_DEV=root / "net-dev",
            FILESYSTEMS={"state": root, "root": root / "absent"},
            workloads=lambda namespace: [],
        )

    def test_node_metrics_is_a_valid_strict_message_and_skips_unreadable_groups(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            self.files(directory, loadavg=None),
        ):
            value = metrics.node_metrics("personal-cloud")
        self.assertEqual(value["boot_id"], BOOT)
        self.assertEqual(value["uptime_seconds"], 86400.25)
        self.assertNotIn("load", value)
        self.assertNotIn("workloads", value)
        self.assertEqual(set(value["filesystems"]), {"state"})
        self.assertEqual(
            to_wire(from_wire(NodeMetrics, value, strict=True).message), value
        )

    def test_without_boot_identity_there_are_no_metrics(self):
        for override in ({"sys/kernel/random/boot_id": "nope"}, {"uptime": "x"}):
            with (
                tempfile.TemporaryDirectory() as directory,
                self.files(directory, **override),
            ):
                self.assertIsNone(metrics.node_metrics("personal-cloud"))

    def test_report_carries_metrics_only_when_read(self):
        with (
            patch.object(collector, "kube", return_value={"state": "unknown"}),
            patch.object(collector, "resource_percentages", return_value=(None, None)),
            patch.object(
                collector,
                "newsletter",
                return_value={"state": "unknown", "drain_state": "unknown"},
            ),
            patch.object(collector, "runtime_status", return_value=None),
            patch.object(
                collector,
                "systemd_snapshot",
                return_value={
                    name: {"state": "active"}
                    for name in ("k3s", "cloudflared", "ssh", "cloudflared_platform")
                },
            ),
            patch.object(collector, "node_metrics", return_value=None) as read,
        ):
            self.assertNotIn("metrics", json.loads(collector.observe({}, 1)))
            read.assert_called_once_with("personal-cloud")
            fixture = json.loads(
                (
                    Path(__file__).resolve().parents[3]
                    / "contracts/fleet-report-v1/fixtures/node_metrics.json"
                ).read_text()
            )["metrics"]
            read.return_value = fixture
            report = json.loads(
                collector.observe({"FLEET_KUBE_NAMESPACE": "another-cloud"}, 1)
            )
            self.assertEqual(report["metrics"], fixture)
            read.assert_called_with("another-cloud")

            # A report over the 16 KiB bound drops workloads, then metrics, never the heartbeat.
            real = collector._encode

            def oversized_when(predicate):
                return lambda value: (
                    real(value) + (b" " * 16_384 if predicate(value) else b"")
                )

            cases = (
                (lambda value: "workloads" in value.get("metrics", {}), "workloads"),
                (lambda value: "metrics" in value, "metrics"),
            )
            for predicate, dropped in cases:
                read.return_value = json.loads(json.dumps(fixture))
                with patch.object(
                    collector, "_encode", side_effect=oversized_when(predicate)
                ):
                    report = json.loads(collector.observe({}, 1))
                if dropped == "workloads":
                    self.assertNotIn("workloads", report["metrics"])
                    self.assertIn("cpu", report["metrics"])
                else:
                    self.assertNotIn("metrics", report)
            with (
                patch.object(
                    collector, "_encode", side_effect=oversized_when(lambda _: True)
                ),
                self.assertRaises(ObserverError),
            ):
                collector.observe({}, 1)


if __name__ == "__main__":
    unittest.main()
