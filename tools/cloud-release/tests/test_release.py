import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api import Api, ReleaseError
from cloudflare import (
    binding_differences,
    deployment_version,
    routes_differences,
    verify_resources,
)
from control import prepare
from deployments import last_good, record_success

SHA = "a" * 40
UUID = "6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"


class FakeApi:
    def __init__(self, results):
        self.results, self.requests = iter(results), []

    def call(self, path, **kwargs):
        self.requests.append((path, kwargs))
        result = next(self.results)
        if isinstance(result, Exception):
            raise result
        return result


class ApiMetadataTests(unittest.TestCase):
    def api(self, response):
        class Opener:
            def open(self, request, timeout):
                return io.BytesIO(json.dumps(response).encode())
        return Api("cloudflare", "synthetic-token", Opener())

    def test_existing_callers_receive_result_without_metadata(self):
        response = {"success": True, "result": [{"id": "demo"}], "result_info": {"total_count": 2}}
        self.assertEqual(self.api(response).call("/accounts/demo/workers/scripts"), response["result"])

    def test_inventory_can_request_full_pagination_envelope(self):
        response = {"success": True, "result": {"buckets": []}, "result_info": {"cursor": "next"}}
        self.assertEqual(self.api(response).call("/accounts/demo/r2/buckets", include_metadata=True), response)

    def test_metadata_request_does_not_bypass_provider_success_validation(self):
        for response in [{"success": False, "result": []}, [], {"result": []}]:
            with self.subTest(response=response), self.assertRaisesRegex(ReleaseError, "CLOUDFLARE_RESPONSE_INVALID"):
                self.api(response).call("/accounts/demo/r2/buckets", include_metadata=True)


class ReleaseTests(unittest.TestCase):
    def test_only_latest_single_version_at_full_traffic_is_accepted(self):
        self.assertEqual(
            deployment_version(
                {
                    "deployments": [
                        {"versions": [{"version_id": UUID, "percentage": 100}]}
                    ]
                }
            ),
            UUID,
        )
        for versions in (
            [],
            [{"version_id": UUID, "percentage": 50}],
            [{"version_id": UUID, "percentage": 50}] * 2,
        ):
            with self.subTest(versions=versions), self.assertRaises(ReleaseError):
                deployment_version({"deployments": [{"versions": versions}]})

    def test_last_good_uses_actual_deployment_success_independently_for_each_app(self):
        records = [
            {
                "id": 3,
                "sha": "b" * 40,
                "payload": {"format": "personal-cloud-release-v1"},
            },
            {"id": 2, "sha": "c" * 40, "payload": {}},
            {"id": 1, "sha": SHA, "payload": {"format": "personal-cloud-release-v1"}},
        ]
        api = FakeApi([records, [{"state": "failure"}], [{"state": "success"}]])
        self.assertEqual(last_good(api, "example/cloud", "fleet")["sha"], SHA)
        self.assertIn("task=deploy:fleet", api.requests[0][0])
        self.assertEqual(len(api.requests), 3)

    def test_failed_or_legacy_records_never_become_repair_targets(self):
        for payload in ({}, {"format": "personal-cloud-release-v1"}):
            api = FakeApi(
                [[{"id": 1, "sha": SHA, "payload": payload}], [{"state": "failure"}]]
            )
            with (
                self.subTest(payload=payload),
                self.assertRaisesRegex(ReleaseError, "VERIFIED_DEPLOYMENT_MISSING"),
            ):
                last_good(api, "example/cloud", "fleet")

    def test_document_head_cannot_replace_a_services_last_verified_sha(self):
        record = {
            "id": 1,
            "sha": SHA,
            "payload": {"format": "personal-cloud-release-v1"},
        }
        with patch.dict(
            os.environ, {"GITHUB_REPOSITORY": "example/cloud", "GITHUB_SHA": "b" * 40}
        ):
            self.assertEqual(
                prepare("fleet", "", True, FakeApi([[record], [{"state": "success"}]])),
                SHA,
            )
            with self.assertRaisesRegex(ReleaseError, "REPAIR_TARGET_CHANGED"):
                prepare(
                    "fleet", "b" * 40, True, FakeApi([[record], [{"state": "success"}]])
                )
            with self.assertRaisesRegex(ReleaseError, "RELEASE_SOURCE_UNCHECKED"):
                prepare("fleet", SHA, False, FakeApi([]))

    def test_provider_proof_is_attached_to_exact_sha_without_auto_merge(self):
        api = FakeApi([{"id": 1, "sha": SHA}, {}])
        self.assertEqual(
            record_success(
                api,
                "example/cloud",
                "fleet",
                SHA,
                {"workers": []},
                "https://github.com/example/cloud/actions/runs/1",
            ),
            1,
        )
        body = api.requests[0][1]["body"]
        self.assertFalse(body["auto_merge"])
        self.assertEqual(body["ref"], SHA)
        self.assertEqual(api.requests[1][1]["body"]["state"], "success")

    def test_binding_targets_and_optional_secrets_are_checked_without_values_in_diagnostics(
        self,
    ):
        config = {
            "vars": {"PUBLIC_HOST": "fleet.example.com"},
            "d1_databases": [{"binding": "DB", "database_id": UUID}],
        }
        desired = {
            "bindings": [
                {"name": "PUBLIC_HOST", "type": "plain_text"},
                {"name": "DB", "type": "d1"},
                {"name": "OPTIONAL", "type": "secret_text", "optional": True},
            ]
        }
        bindings = [
            {
                "name": "PUBLIC_HOST",
                "type": "plain_text",
                "text": "changed.example.com",
            },
            {"name": "DB", "type": "d1", "id": "unknown"},
        ]
        changes = binding_differences(config, desired, {}, bindings, SHA)
        self.assertEqual(
            {item["reason"] for item in changes},
            {"PUBLIC_VAR_CHANGED", "STATEFUL_BINDING_CHANGED"},
        )
        self.assertNotIn("changed.example.com", json.dumps(changes))
        self.assertNotIn("unknown", json.dumps(changes))

    def test_absent_database_or_bucket_stops_before_any_write(self):
        api = FakeApi([ReleaseError("PROVIDER_HTTP_404")])
        with self.assertRaisesRegex(ReleaseError, "PROVIDER_HTTP_404"):
            verify_resources(
                api,
                {"account_id": "a" * 32},
                [{"d1_databases": [{"database_id": UUID}]}],
            )
        self.assertEqual(api.requests[0][1], {})

    def test_service_target_checks_source_props_and_environment_without_logging_values(
        self,
    ):
        config = {
            "services": [
                {
                    "binding": "TODOFY",
                    "service": "todofy",
                    "entrypoint": "Intents",
                    "props": {"source": "watch"},
                }
            ]
        }
        desired = {"bindings": [{"name": "TODOFY", "type": "service"}]}
        binding = {
            "name": "TODOFY",
            "type": "service",
            "service": "todofy",
            "entrypoint": "Intents",
            "environment": "production",
            "props": {"source": "watch"},
        }
        self.assertEqual(binding_differences(config, desired, {}, [binding], SHA), [])
        for changed in (
            {"props": {"source": "synthetic-private-source"}},
            {"props": {}},
            {"environment": "synthetic-private-environment"},
            {"service": "another-worker"},
            {"entrypoint": "AnotherEntrypoint"},
        ):
            with self.subTest(fields=list(changed)):
                changes = binding_differences(
                    config, desired, {}, [{**binding, **changed}], SHA
                )
                self.assertEqual(
                    changes, [{"field": "TODOFY", "reason": "BINDING_TARGET_CHANGED"}]
                )
                self.assertNotIn("synthetic-private", json.dumps(changes))

    def test_service_default_environment_and_empty_props_have_the_same_target(self):
        config = {"services": [{"binding": "CORE", "service": "todofy-core"}]}
        desired = {"bindings": [{"name": "CORE", "type": "service"}]}
        binding = {"name": "CORE", "type": "service", "service": "todofy-core"}
        for defaults in (
            {},
            {"environment": "production", "props": {}},
            {"environment": None, "props": None},
        ):
            with self.subTest(defaults=defaults):
                self.assertEqual(
                    binding_differences(
                        config, desired, {}, [{**binding, **defaults}], SHA
                    ),
                    [],
                )

    def test_unexposed_service_props_do_not_mean_empty_deployed_props(self):
        config = {
            "services": [
                {
                    "binding": "TODOFY",
                    "service": "todofy",
                    "entrypoint": "Intents",
                    "props": {"source": "watch"},
                }
            ]
        }
        desired = {"bindings": [{"name": "TODOFY", "type": "service"}]}
        binding = {
            "name": "TODOFY",
            "type": "service",
            "service": "todofy",
            "entrypoint": "Intents",
            "environment": "production",
        }
        self.assertEqual(binding_differences(config, desired, {}, [binding], SHA), [])
        for changed in (
            {"service": "another-worker"},
            {"entrypoint": "AnotherEntrypoint"},
            {"environment": "staging"},
            {"props": {}},
        ):
            with self.subTest(fields=list(changed)):
                self.assertEqual(
                    binding_differences(
                        config, desired, {}, [{**binding, **changed}], SHA
                    ),
                    [{"field": "TODOFY", "reason": "BINDING_TARGET_CHANGED"}],
                )

    def test_declared_service_environment_is_compared(self):
        config = {
            "services": [
                {"binding": "CORE", "service": "todofy-core", "environment": "staging"}
            ]
        }
        desired = {"bindings": [{"name": "CORE", "type": "service"}]}
        binding = {
            "name": "CORE",
            "type": "service",
            "service": "todofy-core",
            "environment": "staging",
        }
        self.assertEqual(binding_differences(config, desired, {}, [binding], SHA), [])
        self.assertEqual(
            binding_differences(
                config, desired, {}, [{**binding, "environment": "production"}], SHA
            ),
            [{"field": "CORE", "reason": "BINDING_TARGET_CHANGED"}],
        )

    def test_extra_or_missing_domain_is_reported(self):
        api = FakeApi([[{"service": "fleet", "hostname": "old.example.com"}], []])
        changes = routes_differences(
            api,
            "a" * 32,
            "b" * 32,
            "fleet",
            {"custom_domains": ["fleet.example.com"], "routes": []},
        )
        self.assertEqual(
            changes, [{"field": "domains", "reason": "DOMAIN_REMOVAL_REQUIRED"}]
        )


if __name__ == "__main__":
    unittest.main()
