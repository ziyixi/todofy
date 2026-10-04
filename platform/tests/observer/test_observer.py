"""Synthetic observer checks; never read real host state or credentials."""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from personal_cloud.observer import collector, provenance, state
from personal_cloud.observer.transport import ObserverError


class ObserverTests(unittest.TestCase):
    def environment(self, directory):
        return {
            "FLEET_REPORT_URL": "https://fleet.example.com/api/internal/fleet/v1/receipt",
            "FLEET_REPORT_HMAC_KEY": "a" * 64,
            "FLEET_STATE_DIR": directory,
        }

    def report(self, sequence):
        return json.dumps(
            {
                "sequence": sequence,
                "receipt_id": "fixture",
                "observation_time": dt.datetime.now(dt.timezone.utc).isoformat(),
            }
        ).encode()

    def test_failed_send_retries_identical_signed_bytes_without_new_observation(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                state,
                "observe",
                side_effect=lambda env, sequence: self.report(sequence),
            ) as observe,
        ):
            env = self.environment(directory)
            calls = []

            def send(url, *, headers, data, limit):
                calls.append((data, headers))
                expected = hmac.new(
                    bytes.fromhex("a" * 64), data, hashlib.sha256
                ).hexdigest()
                self.assertEqual(headers["X-Fleet-Signature"], expected)
                if len(calls) == 1:
                    raise ObserverError("observation_unavailable")
                return 200, {
                    "version": "fleet-receipt-v1",
                    "accepted": False,
                    "sequence": 1,
                }

            with patch.object(state, "_request", side_effect=send):
                with self.assertRaises(ObserverError):
                    state.run(env)
                state.run(env)
            self.assertEqual(calls[0], calls[1])
            observe.assert_called_once()
            path = Path(directory) / "state.json"
            self.assertEqual(json.loads(path.read_text()), {"sequence": 1})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_new_receipt_is_reserved_before_transmission(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                state,
                "observe",
                side_effect=lambda env, sequence: self.report(sequence),
            ),
        ):

            def send(url, *, headers, data, limit):
                reserved = json.loads((Path(directory) / "state.json").read_text())
                self.assertEqual(reserved["pending"].encode(), data)
                return 200, {
                    "version": "fleet-receipt-v1",
                    "accepted": True,
                    "sequence": reserved["sequence"],
                }

            with patch.object(state, "_request", side_effect=send):
                state.run(self.environment(directory))
                state.run(self.environment(directory))
            self.assertEqual(
                json.loads((Path(directory) / "state.json").read_text()),
                {"sequence": 2},
            )

    def test_boolean_sequence_ack_cannot_confirm_persistence(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                state,
                "observe",
                side_effect=lambda env, sequence: self.report(sequence),
            ),
            patch.object(
                state,
                "_request",
                return_value=(
                    200,
                    {"version": "fleet-receipt-v1", "accepted": True, "sequence": True},
                ),
            ),
        ):
            with self.assertRaises(ObserverError):
                state.run(self.environment(directory))
            self.assertIn(
                "pending", json.loads((Path(directory) / "state.json").read_text())
            )

    def test_report_endpoint_cannot_redirect_credential_via_url_components(self):
        with self.assertRaises(ObserverError):
            state.run(
                {
                    "FLEET_REPORT_URL": "https://user@example.com/api/internal/fleet/v1/receipt"
                }
            )
        with self.assertRaises(ObserverError):
            state.run(
                {"FLEET_REPORT_URL": "http://example.com/api/internal/fleet/v1/receipt"}
            )

    def test_monitor_reads_only_its_bounded_response_contract(self):
        valid = {
            "version": 1,
            "worker_healthy": True,
            "drain_state": "frozen",
            "queued_count": 4,
            "inflight_count": 0,
            "unknown_count": 2,
            "build_source_sha": None,
            "release_request_id": None,
        }
        with patch.object(collector, "_request", return_value=(200, valid)) as send:
            result = collector.newsletter({"NEWSLETTER_MONITOR_TOKEN": "synthetic"})
            self.assertEqual(result["state"], "healthy")
            self.assertEqual(result["drain_state"], "frozen")
            self.assertEqual(
                send.call_args.args[0],
                "http://newsletter:8080/internal/monitoring/status",
            )
        for invalid in (
            {**valid, "queued_count": True},
            {**valid, "logs": "sensitive"},
            {**valid, "version": True},
        ):
            with patch.object(collector, "_request", return_value=(200, invalid)):
                self.assertEqual(
                    collector.newsletter({"NEWSLETTER_MONITOR_TOKEN": "synthetic"})[
                        "state"
                    ],
                    "unavailable",
                )

    def runtime_fixture(self):
        root = Path(__file__).resolve().parents[3]
        value = json.loads(
            (root / "contracts/fleet-report-v1/fixtures/healthy.json").read_text()
        )["runtime"]
        now = (
            dt.datetime.now(dt.timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
        value["observed_at"] = now
        for workload in value["workloads"]:
            workload["observed_at"] = now
            workload["release"]["observed_at"] = now
        return value

    def test_generic_runtime_uses_shared_profile_and_refuses_private_fields(self):
        valid = self.runtime_fixture()
        with patch.object(collector, "_request", return_value=(200, valid)) as request:
            value = collector.runtime_status({})
            self.assertEqual(value["workloads"][0]["release"]["state"], "ready")
            self.assertEqual(
                request.call_args.args[0],
                "http://platform-runtime:8080/api/v1/nodeStatus",
            )
        for invalid in ({**valid, "logs": "private"}, {**valid, "node_key": "other"}):
            with patch.object(collector, "_request", return_value=(200, invalid)):
                self.assertIsNone(collector.runtime_status({}))

    def test_runtime_stale_duplicate_keys_and_unknown_actual_are_distinct(self):
        valid = self.runtime_fixture()
        valid["workloads"][0]["release"]["state"] = "unknown"
        valid["workloads"][0]["release"]["actual"] = None
        with patch.object(collector, "_request", return_value=(200, valid)):
            self.assertIsNone(
                collector.runtime_status({})["workloads"][0]["release"]["actual"]
            )
        invalid = {**valid, "workloads": valid["workloads"] * 2}
        with patch.object(collector, "_request", return_value=(200, invalid)):
            self.assertIsNone(collector.runtime_status({}))
        invalid = {**valid, "observed_at": "2026-01-01T00:00:00Z"}
        with patch.object(collector, "_request", return_value=(200, invalid)):
            self.assertIsNone(collector.runtime_status({}))

    def test_observer_identity_comes_only_from_baked_package_metadata(self):
        with patch.object(provenance.importlib.resources, "files") as resource:
            resource.return_value.joinpath.return_value.read_text.return_value = (
                json.dumps({"source_sha": "1" * 40})
            )
            self.assertEqual(provenance.source_sha(), "1" * 40)
            resource.assert_called_with("personal_cloud")
            for value in (None, "mutable-main", "wrong", {"path": "private"}):
                resource.return_value.joinpath.return_value.read_text.return_value = (
                    json.dumps({"source_sha": value})
                )
                self.assertIsNone(provenance.source_sha())

    def test_kube_namespace_is_configured_and_cannot_escape_request_paths(self):
        for namespace in ("../other", "personal/cloud", "", "UPPER", "x" * 64):
            with self.assertRaises(ObserverError):
                collector.kube({"FLEET_KUBE_NAMESPACE": namespace})
        with patch.object(collector, "Client") as constructor:
            client = constructor.return_value
            client.get.return_value = {
                "status": {"readyReplicas": 1},
                "spec": {"replicas": 1},
            }
            client.nodes.return_value = {
                "items": [
                    {"status": {"conditions": [{"type": "Ready", "status": "True"}]}}
                ]
            }
            client.pods.return_value = {"items": []}
            result = collector.kube(
                {
                    "FLEET_KUBE_NAMESPACE": "another-cloud",
                }
            )
            self.assertEqual(result["state"], "ready")
            self.assertEqual(constructor.call_args.args[0], "another-cloud")
            self.assertNotIn("origin", constructor.call_args.kwargs)
            self.assertEqual(
                constructor.call_args.kwargs["token_file"],
                "/var/run/secrets/kubernetes.io/serviceaccount/token",
            )
            client.get.assert_called_once_with("Deployment", "newsletter", timeout=8)
            client.nodes.assert_called_once_with(timeout=8)
            client.pods.assert_called_once_with("newsletter", timeout=8)
            client.close.assert_called_once()

    def test_optional_transport_daemon_is_not_expected_before_transport_selection(self):
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
        ):
            base = json.loads(collector.observe({}, 1))
            self.assertEqual(set(base["daemons"]), {"k3s", "cloudflared", "ssh"})
            enabled = json.loads(
                collector.observe({"FLEET_EXPECT_PLATFORM_TUNNEL": "true"}, 1)
            )
            self.assertIn("cloudflared_platform", enabled["daemons"])

            aliases = ["k3s", "ssh", "cloudflared_platform"]
            fresh = json.loads(
                collector.observe(
                    {
                        "FLEET_EXPECTED_DAEMONS": json.dumps(aliases),
                        "FLEET_EXPECT_PLATFORM_TUNNEL": "true",
                    },
                    1,
                )
            )
            self.assertEqual(set(fresh["configured_daemons"]), set(aliases))
            self.assertEqual(fresh["daemons"]["cloudflared"], {"state": "unknown"})
            self.assertEqual(
                fresh["configured_daemons"]["cloudflared_platform"], {"state": "active"}
            )


if __name__ == "__main__":
    unittest.main()
