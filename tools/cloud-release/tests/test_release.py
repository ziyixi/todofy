import io
import json
import os
import sys
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from api import Api, ReleaseError
from cloudflare import (
    binding_differences,
    deployment_version,
    routes_differences,
    verify_resources,
)
from control import WORKERS, prepare
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
    def test_http_failure_projects_provider_method_and_status_without_private_values(
        self,
    ):
        private = "synthetic-private-token /private/path 192.0.2.19"

        class Opener:
            def open(self, request, timeout):
                error = urllib.error.HTTPError(
                    "https://private.invalid/" + private,
                    500,
                    private,
                    {"private": private},
                    io.BytesIO(private.encode()),
                )
                error.close()
                raise error

        api, output = Api("github", private, Opener()), io.StringIO()
        with (
            redirect_stdout(output),
            self.assertRaisesRegex(ReleaseError, "^PROVIDER_HTTP_500$"),
        ):
            api.call(
                "/repos/example/cloud/deployments",
                method="POST",
                body={"private": private},
            )
        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "event": "release_provider_failure",
                "provider": "github",
                "method": "POST",
                "http_status": 500,
            },
        )
        self.assertNotIn(private, output.getvalue())
        self.assertNotIn("https://", output.getvalue())

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
    def test_record_only_requires_a_main_ancestor_and_its_green_gate(self):
        saved = {
            "id": 1,
            "sha": SHA,
            "task": "deploy:tasks",
            "environment": "production",
            "payload": {"format": "personal-cloud-release-v1"},
        }
        for conclusion in ("success", "failure", "cancelled", "skipped"):
            api = FakeApi(
                [
                    {"object": {"sha": "b" * 40}},
                    saved,
                    {"status": "ahead", "merge_base_commit": {"sha": SHA}},
                    {
                        "workflow_runs": [
                            {
                                "id": 7,
                                "head_sha": SHA,
                                "head_branch": "main",
                                "event": "push",
                                "status": "completed",
                                "conclusion": "failure",
                            }
                        ]
                    },
                    {
                        "total_count": 1,
                        "jobs": [
                            {
                                "id": 8,
                                "name": "CI gate",
                                "head_sha": SHA,
                                "status": "completed",
                                "conclusion": conclusion,
                            }
                        ],
                    },
                ]
            )
            with (
                self.subTest(conclusion=conclusion),
                patch.dict(
                    os.environ,
                    {"GITHUB_REPOSITORY": "example/cloud", "GITHUB_SHA": "b" * 40},
                ),
            ):
                if conclusion == "success":
                    self.assertEqual(
                        prepare(
                            "tasks",
                            "",
                            False,
                            api,
                            "b" * 40,
                            record_only=True,
                            deployment_id="1",
                        ),
                        SHA,
                    )
                else:
                    with self.assertRaisesRegex(
                        ReleaseError, "RECEIPT_CI_GATE_NOT_VERIFIED"
                    ):
                        prepare(
                            "tasks",
                            "",
                            False,
                            api,
                            "b" * 40,
                            record_only=True,
                            deployment_id="1",
                        )
            self.assertTrue(
                all(
                    not options or options.get("method", "GET") == "GET"
                    for _, options in api.requests
                )
            )
        api = FakeApi(
            [
                {"object": {"sha": "b" * 40}},
                saved,
                {"status": "diverged", "merge_base_commit": {"sha": "c" * 40}},
            ]
        )
        with (
            patch.dict(
                os.environ,
                {"GITHUB_REPOSITORY": "example/cloud", "GITHUB_SHA": "b" * 40},
            ),
            self.assertRaisesRegex(ReleaseError, "RECEIPT_SOURCE_NOT_MAIN"),
        ):
            prepare(
                "tasks", "", False, api, "b" * 40, record_only=True, deployment_id="1"
            )

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

    def test_inactive_record_retains_its_prior_verified_success(self):
        record = {"id": 1, "sha": SHA, "payload": {"format": "personal-cloud-release-v1"}}
        api = FakeApi([[record], [{"state": "inactive"}, {"state": "success"}]])
        self.assertEqual(last_good(api, "example/cloud", "mailsort"), record)
        self.assertEqual(
            api.requests[1][0],
            "/repos/example/cloud/deployments/1/statuses?per_page=10",
        )
        self.assertEqual(len(api.requests), 2)

    def test_inactive_record_without_success_in_bounded_history_is_rejected(self):
        record = {"id": 1, "sha": SHA, "payload": {"format": "personal-cloud-release-v1"}}
        for statuses in (
            [{"state": "inactive"}],
            [{"state": "inactive"}] * 10 + [{"state": "success"}],
        ):
            with (
                self.subTest(statuses=statuses),
                self.assertRaisesRegex(ReleaseError, "VERIFIED_DEPLOYMENT_MISSING"),
            ):
                last_good(FakeApi([[record], statuses]), "example/cloud", "mailsort")

    def test_latest_failure_or_error_does_not_promote_a_prior_success(self):
        record = {"id": 1, "sha": SHA, "payload": {"format": "personal-cloud-release-v1"}}
        for state in ("failure", "error"):
            with (
                self.subTest(state=state),
                self.assertRaisesRegex(ReleaseError, "VERIFIED_DEPLOYMENT_MISSING"),
            ):
                last_good(
                    FakeApi([[record], [{"state": state}, {"state": "success"}]]),
                    "example/cloud",
                    "mailsort",
                )

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

    def test_every_declared_worker_can_prepare_its_first_checked_release(self):
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": "example/cloud", "GITHUB_SHA": SHA}):
            for app in WORKERS:
                with self.subTest(app=app):
                    api = FakeApi([])
                    self.assertEqual(prepare(app, SHA, False, api), SHA)
                    self.assertEqual(api.requests, [])
            for app in ("model_router", "model-router-extra", "unknown"):
                with self.subTest(app=app), self.assertRaisesRegex(ReleaseError, "DEPLOYMENT_IDENTITY_INVALID"):
                    prepare(app, SHA, False, FakeApi([]))

    def test_router_verification_records_the_same_release_identity(self):
        api = FakeApi([{"id": 1, "sha": SHA}, {}])
        self.assertEqual(record_success(api, "example/cloud", "model-router", SHA,
                                      {"workers": []}, "https://github.com/example/cloud/actions/runs/1"), 1)
        body = api.requests[0][1]["body"]
        self.assertEqual(body["task"], "deploy:model-router")
        self.assertEqual(body["ref"], SHA)
        self.assertEqual(api.requests[1][1]["body"]["state"], "success")

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

    def test_a_new_binding_is_only_missing_and_a_changed_target_is_stateful(self):
        config = {
            "d1_databases": [{"binding": "DB", "database_id": UUID}],
            "r2_buckets": [{"binding": "BACKUPS", "bucket_name": "synthetic-backups"}],
            "services": [{"binding": "INBOX", "service": "tasks", "entrypoint": "TaskInbox"}],
        }
        desired = {
            "bindings": [
                {"name": "DB", "type": "d1"},
                {"name": "BACKUPS", "type": "r2_bucket"},
                {"name": "INBOX", "type": "service"},
            ]
        }
        live = [{"name": "DB", "type": "d1", "id": UUID}]
        self.assertEqual(
            binding_differences(config, desired, {}, live, SHA),
            [
                {"field": "BACKUPS", "reason": "BINDING_MISSING"},
                {"field": "INBOX", "reason": "BINDING_MISSING"},
            ],
        )
        moved = [
            *live,
            {"name": "BACKUPS", "type": "r2_bucket", "bucket_name": "another-bucket"},
            {"name": "INBOX", "type": "service", "service": "tasks", "entrypoint": "TaskInbox"},
        ]
        self.assertEqual(
            binding_differences(config, desired, {}, moved, SHA),
            [{"field": "BACKUPS", "reason": "STATEFUL_BINDING_CHANGED"}],
        )

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
