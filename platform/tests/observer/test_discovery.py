"""Synthetic labelled workloads only; no real cluster or business data."""

from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from personal_cloud.observer import discovery
from personal_cloud.observer.metrics import WORKLOAD_LABEL


def deployment(key="new-service", namespace="private-space", *, desired=1):
    return {
        "kind": "Deployment",
        "metadata": {
            "name": "internal-deployment",
            "namespace": namespace,
            "generation": 2,
            "labels": {WORKLOAD_LABEL: key},
        },
        "spec": {
            "replicas": desired,
            "template": {
                "spec": {
                    "containers": [
                        {
                            "name": "main",
                            "readinessProbe": {
                                "httpGet": {"path": "/ready", "port": 8080}
                            },
                        }
                    ]
                }
            },
        },
        "status": {"observedGeneration": 2, "readyReplicas": desired},
    }


def pod(key="new-service", namespace="private-space", *, phase="Running", ready=True):
    return {
        "metadata": {
            "name": "internal-pod",
            "namespace": namespace,
            "labels": {WORKLOAD_LABEL: key},
        },
        "status": {
            "phase": phase,
            "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
            "containerStatuses": [{"ready": ready, "restartCount": 3}],
        },
    }


def inventory(deployments, pods):
    return discovery.inventory({"items": deployments}, {"items": pods})[0]


class DiscoveryTests(unittest.TestCase):
    def test_new_aliases_across_namespaces_are_sorted_without_exposing_resource_names(
        self,
    ):
        value = inventory(
            [deployment("z-service"), deployment("a-service", "other-space")],
            [pod("z-service"), pod("a-service", "other-space")],
        )
        self.assertEqual(value["state"], "observed")
        self.assertEqual(
            [row["workload_key"] for row in value["workloads"]],
            ["a-service", "z-service"],
        )
        self.assertTrue(all(row["state"] == "ready" for row in value["workloads"]))
        self.assertEqual(value["workloads"][0]["restart_count"], 3)
        self.assertTrue(value["workloads"][0]["readiness_probe"])
        text = json.dumps(value)
        for private in (
            "internal-deployment",
            "internal-pod",
            "private-space",
            "other-space",
            "/ready",
        ):
            self.assertNotIn(private, text)

    def test_zero_pods_stopped_pending_and_nonready_have_distinct_states(self):
        desired = deployment()
        desired["status"]["readyReplicas"] = 0
        self.assertEqual(inventory([desired], [])["workloads"][0]["state"], "starting")
        self.assertEqual(
            inventory([deployment(desired=0)], [])["workloads"][0]["state"], "stopped"
        )
        self.assertEqual(
            inventory([desired], [pod(phase="Pending", ready=False)])["workloads"][0][
                "state"
            ],
            "starting",
        )
        self.assertEqual(
            inventory([desired], [pod(ready=False)])["workloads"][0]["state"],
            "degraded",
        )

    def test_generation_and_invalid_status_cannot_claim_readiness(self):
        stale = deployment()
        stale["status"]["observedGeneration"] = 1
        self.assertEqual(
            inventory([stale], [pod()])["workloads"][0]["state"], "starting"
        )
        for field, value in (
            ("observedGeneration", None),
            ("readyReplicas", -1),
            ("readyReplicas", True),
        ):
            invalid = deployment()
            invalid["status"][field] = value
            self.assertEqual(
                inventory([invalid], [pod()])["workloads"][0]["state"], "unknown"
            )
        unprobed = deployment()
        unprobed["spec"]["template"]["spec"]["containers"][0].pop("readinessProbe")
        self.assertFalse(
            inventory([unprobed], [pod()])["workloads"][0]["readiness_probe"]
        )

    def test_deployment_failure_conditions_override_starting_without_claiming_ready(
        self,
    ):
        for condition in (
            {"type": "Progressing", "status": "False"},
            {"type": "ReplicaFailure", "status": "True"},
        ):
            failed = deployment()
            failed["status"].update(readyReplicas=0, conditions=[condition])
            for observed in (1, 2):
                failed["status"]["observedGeneration"] = observed
                self.assertEqual(
                    inventory([failed], [])["workloads"][0]["state"], "degraded"
                )

    def test_terminating_and_terminal_pods_do_not_change_counts_aliases_or_limit(self):
        pending = pod(phase="Pending", ready=False)
        terminating = pod()
        terminating["metadata"].update(
            name="old-pod", deletionTimestamp="2026-11-08T00:00:00Z"
        )
        terminating["status"]["containerStatuses"][0]["restartCount"] = 99
        terminal = [
            pod(namespace="another-space", phase=phase)
            for phase in ("Succeeded", "Failed")
        ]
        value, selected = discovery.inventory(
            {"items": [deployment()]},
            {"items": [terminating, *terminal * 33, pending]},
        )
        self.assertEqual(value["state"], "observed")
        self.assertEqual(selected, [pending])
        self.assertEqual(value["workloads"][0]["state"], "starting")
        self.assertEqual(value["workloads"][0]["ready_count"], 0)
        self.assertEqual(value["workloads"][0]["restart_count"], 3)
        self.assertEqual(discovery.inventory({"items": []}, {"items": terminal})[1], [])

    def test_namespace_and_duplicate_deployment_alias_collisions_refuse_both_selections(
        self,
    ):
        for deployments, pods in (
            ([deployment(), deployment(namespace="another-space")], []),
            ([deployment(), deployment()], []),
            ([deployment()], [pod(namespace="another-space")]),
            ([], [pod(), pod(namespace="another-space")]),
        ):
            value, selected = discovery.inventory(
                {"items": deployments}, {"items": pods}
            )
            self.assertEqual(value, {"state": "unavailable", "workloads": []})
            self.assertEqual(selected, [])

    def test_lists_and_inventory_are_bounded_and_cronjob_pods_only_feed_usage(self):
        value, selected = discovery.inventory({"items": []}, {"items": [pod()]})
        self.assertEqual(value, {"state": "observed", "workloads": []})
        self.assertEqual(len(selected), 1)
        many = [deployment(f"service-{index:02}") for index in range(17)]
        value = inventory(many, [])
        self.assertEqual(value["state"], "truncated")
        self.assertEqual(len(value["workloads"]), 16)
        for deployments, pods in (
            (
                {"metadata": {"continue": "next"}, "items": [deployment()]},
                {"items": []},
            ),
            ({"items": []}, {"items": [pod()] * 65}),
        ):
            self.assertEqual(
                discovery.inventory(deployments, pods),
                ({"state": "truncated", "workloads": []}, []),
            )

    def test_fixed_readonly_requests_use_selector_and_forbidden_is_unavailable(self):
        with (
            patch.object(discovery.sdk, "ApiClient") as api,
            patch.object(discovery.DiscoveryClient, "_configuration"),
        ):
            api.return_value.call_api.side_effect = [
                {"items": [deployment()]},
                {"items": [pod()]},
            ]
            value, _ = discovery.discover("personal-cloud")
            self.assertEqual(value["workloads"][0]["state"], "ready")
            self.assertEqual(
                [call.args for call in api.return_value.call_api.call_args_list],
                [("/apis/apps/v1/deployments", "GET"), ("/api/v1/pods", "GET")],
            )
            for index, call in enumerate(api.return_value.call_api.call_args_list):
                self.assertEqual(
                    call.kwargs["query_params"],
                    [("labelSelector", WORKLOAD_LABEL), ("limit", 64)]
                    + (
                        [
                            (
                                "fieldSelector",
                                "status.phase!=Succeeded,status.phase!=Failed",
                            )
                        ]
                        if index == 1
                        else []
                    ),
                )
                self.assertEqual(call.kwargs["auth_settings"], ["BearerToken"])
                self.assertEqual(call.kwargs["_request_timeout"], (3, 8))
            api.return_value.call_api.side_effect = discovery.ApiException(status=403)
            self.assertEqual(
                discovery.discover("personal-cloud"),
                ({"state": "unavailable", "workloads": []}, []),
            )
            api.return_value.close.assert_called()


if __name__ == "__main__":
    unittest.main()
