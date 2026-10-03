"""Official SDK boundaries tested at call_api, without a real network or pod credential."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from kubernetes.client.exceptions import ApiException
from personal_cloud.deployment.kubernetes import Client, DependencyUnavailable


class Kubernetes(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.token = Path(self.directory.name) / "token"
        self.token.write_text("first-synthetic-token-value")
        self.calls = []
        owner = self

        class SDK:
            def __init__(inner, configuration):
                inner.configuration = configuration

            def call_api(inner, path, method, **options):
                identity = inner.configuration.get_api_key_with_prefix("authorization")
                owner.calls.append(
                    (path, method, options, identity, inner.configuration)
                )
                return {
                    "metadata": {"resourceVersion": "123"},
                    "status": {"observedGeneration": 7},
                }

            def close(inner):
                pass

        self.factory = patch(
            "personal_cloud.deployment.kubernetes.client.ApiClient", SDK
        )
        self.factory.start()
        self.addCleanup(self.factory.stop)
        self.client = Client(
            "personal-cloud", token_file=str(self.token), ca_file="synthetic-ca"
        )
        self.addCleanup(self.client.close)

    def test_stable_namespace_api_projected_rotation_and_physical_field_casing(self):
        value = self.client.get("Deployment", "newsletter", timeout=2)
        self.assertEqual(value["status"], {"observedGeneration": 7})
        self.token.write_text("rotated-synthetic-token-value")
        self.client.pods("newsletter", timeout=1)
        first, last = self.calls
        self.assertEqual(
            first[:2],
            ("/apis/apps/v1/namespaces/{namespace}/deployments/{name}", "GET"),
        )
        self.assertEqual(
            first[2]["path_params"],
            {"namespace": "personal-cloud", "name": "newsletter"},
        )
        self.assertEqual(
            last[2]["query_params"],
            [("labelSelector", "app=newsletter"), ("limit", 20)],
        )
        self.assertEqual(first[3], "Bearer first-synthetic-token-value")
        self.assertEqual(last[3], "Bearer rotated-synthetic-token-value")
        self.assertEqual(last[2]["_request_timeout"], (1, 1))
        self.assertEqual(first[4].host, "https://kubernetes.default.svc")
        self.assertTrue(first[4].verify_ssl)
        self.assertEqual(first[4].ssl_ca_cert, "synthetic-ca")
        self.assertIsNone(first[4].proxy)
        self.assertEqual(first[4].retries, 0)
        self.assertFalse(first[4].debug)

    def test_apply_and_patch_use_sdk_media_types_and_no_forced_field_takeover(self):
        self.client.apply(
            {
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": {"namespace": "personal-cloud", "name": "newsletter"},
            }
        )
        self.client.patch("CronJob", "newsletter-daily", {"spec": {"suspend": True}})
        self.assertEqual(self.calls[0][1], "PATCH")
        self.assertEqual(
            self.calls[0][2]["header_params"]["Content-Type"],
            "application/apply-patch+yaml",
        )
        self.assertEqual(
            self.calls[0][2]["query_params"],
            [("fieldManager", "personal-cloud"), ("force", "false")],
        )
        self.assertEqual(
            self.calls[1][2]["header_params"]["Content-Type"],
            "application/merge-patch+json",
        )
        with self.assertRaises(ValueError):
            self.client.apply(
                {"kind": "Deployment", "metadata": {"namespace": "foreign"}}
            )
        with self.assertRaises(ValueError):
            self.client.apply(
                {"kind": "Pod", "metadata": {"namespace": "personal-cloud"}}
            )
        self.assertEqual(len(self.calls), 2)

    def test_host_origin_and_nodes_are_fixed_readonly_sdk_operations(self):
        host = Client(
            "personal-cloud",
            token_file=str(self.token),
            ca_file="synthetic-ca",
            origin="https://127.0.0.1:6443",
        )
        self.addCleanup(host.close)
        host.nodes(timeout=2)
        self.assertEqual(self.calls[-1][0:2], ("/api/v1/nodes", "GET"))
        self.assertEqual(self.calls[-1][2]["path_params"], {})
        self.assertEqual(self.calls[-1][2]["query_params"], [("limit", 20)])
        self.assertEqual(self.calls[-1][4].host, "https://127.0.0.1:6443")
        for origin in (
            "https://public.example",
            "http://127.0.0.1:6443",
            "https://127.0.0.1:6443/path",
        ):
            with self.assertRaises(ValueError):
                Client("personal-cloud", origin=origin)
        with self.assertRaises(ValueError):
            host.patch("Node", "anything", {})
        with self.assertRaises(ValueError):
            host.apply({"kind": "Node", "metadata": {"name": "anything"}})
        self.assertEqual(len(self.calls), 1)

    def test_sdk_errors_preserve_missing_semantics_without_provider_text(self):
        self.client.get("ConfigMap", "newsletter-release")
        for status in (404, 403, 500):
            with (
                self.subTest(status=status),
                patch.object(
                    self.client._api,
                    "call_api",
                    side_effect=ApiException(
                        status=status, reason="private-provider-body"
                    ),
                ),
                self.assertRaises(DependencyUnavailable) as error,
            ):
                self.client.get("ConfigMap", "newsletter-release")
            self.assertEqual(error.exception.missing, status == 404)
            self.assertEqual(str(error.exception), "KUBERNETES_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
