"""Declared configs through real provider readers; all HTTP stays in memory."""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).absolute().parents[1]))
from api import Api, ReleaseError
import control
from control import ROOT, preflight, record, release_inputs

SHA = "a" * 40
VERSION = "a1234567-1234-4234-8234-123456789abc"


class ProviderFixture:
    """A mutable provider response map, without substituting policy functions."""

    def __init__(self, app):
        self.app = app
        self.profile, self.resources, self.configs, self.desired = release_inputs(
            ROOT, app
        )
        self.values, self.requests, self.deployments, self.statuses = {}, [], [], {}
        self.operational = {}
        account, zone = self.resources["account_id"], self.resources["zone_id"]
        domains, routes = [], []
        for config in self.configs:
            base = "/accounts/" + account + "/workers/scripts/" + config["name"]
            wanted, bindings = self.desired[config["name"]], []
            for item in wanted["bindings"]:
                if item.get("optional"):
                    continue
                binding = {"name": item["name"], "type": item["type"]}
                if item["type"] == "plain_text":
                    value = config.get("vars", {}).get(item["name"], SHA)
                    if item.get("source") == "deploy" and item["name"] != "BUILD_SHA":
                        value = "false"
                        self.operational[
                            app.upper().replace("-", "_") + "_" + item["name"]
                        ] = value
                    binding["text"] = value
                elif item["type"] == "service":
                    source = next(
                        value
                        for value in config["services"]
                        if value["binding"] == item["name"]
                    )
                    binding.update(
                        {
                            key: value
                            for key, value in source.items()
                            if key != "binding"
                        }
                    )
                    binding["environment"] = source.get("environment", "production")
                elif item["type"] == "d1":
                    binding["id"] = next(
                        value["database_id"]
                        for value in config["d1_databases"]
                        if value["binding"] == item["name"]
                    )
                elif item["type"] == "r2_bucket":
                    binding["bucket_name"] = next(
                        value["bucket_name"]
                        for value in config["r2_buckets"]
                        if value["binding"] == item["name"]
                    )
                elif item["type"] == "durable_object_namespace":
                    source = next(
                        value
                        for value in config["durable_objects"]["bindings"]
                        if value["name"] == item["name"]
                    )
                    alias = {
                        "HomeState": "home-state",
                        "WatchState": "watch-state",
                        "MailCoordinator": "mail-coordinator",
                        "TodofyCore": "todofy-core-do",
                        "MailsortState": "mailsort-state",
                    }[source["class_name"]]
                    binding["namespace_id"] = self.resources["durable_objects"][alias]
                bindings.append(binding)
            self.values[base + "/deployments"] = {
                "deployments": [
                    {"versions": [{"version_id": VERSION, "percentage": 100}]}
                ]
            }
            self.values[base + "/versions/" + VERSION] = {
                "resources": {"bindings": bindings}
            }
            self.values[base + "/schedules"] = [
                {"cron": cron} for cron in wanted["crons"]
            ]
            self.values[base + "/subdomain"] = {
                "enabled": wanted["workers_dev"],
                "previews_enabled": wanted["preview_urls"],
            }
            domains.extend(
                {"hostname": host, "service": config["name"]}
                for host in wanted["custom_domains"]
            )
            routes.extend(
                {"pattern": route, "script": config["name"]}
                for route in wanted["routes"]
            )
            for item in config.get("d1_databases", []):
                identifier = item["database_id"]
                self.values["/accounts/" + account + "/d1/database/" + identifier] = {
                    "uuid": identifier
                }
            for item in config.get("r2_buckets", []):
                name = item["bucket_name"]
                self.values["/accounts/" + account + "/r2/buckets/" + name] = {
                    "name": name,
                    "creation_date": "2026-01-01T00:00:00Z",
                }
        self.domain_path = "/accounts/" + account + "/workers/domains"
        self.values[self.domain_path] = domains
        self.values["/zones/" + zone + "/workers/routes"] = routes
        self.cloud = Api("cloudflare", "synthetic-provider-token", opener=self)
        self.github = Api("github", "synthetic-github-token", opener=self)

    def open(self, request, timeout):
        parsed = urlsplit(request.full_url)
        path = parsed.path.removeprefix("/client/v4")
        method = request.get_method()
        self.requests.append((parsed.hostname, method, path))
        if parsed.hostname == "api.cloudflare.com":
            if method != "GET":
                raise AssertionError("Acceptance checks must never mutate Cloudflare")
            value = {"success": True, "result": deepcopy(self.values[path])}
        elif method == "GET" and path.endswith("/deployments"):
            value = list(reversed(self.deployments))
        elif method == "GET" and path.endswith("/statuses"):
            value = self.statuses.get(int(path.split("/")[-2]), [])
        elif method == "POST" and path.endswith("/deployments"):
            body = json.loads(request.data)
            value = {**body, "id": len(self.deployments) + 1, "sha": body["ref"]}
            self.deployments.append(value)
        elif method == "POST" and path.endswith("/statuses"):
            value = json.loads(request.data)
            self.statuses[int(path.split("/")[-2])] = [value]
        else:
            raise AssertionError("Unexpected provider operation")
        return io.BytesIO(json.dumps(value).encode())

    def bindings(self, script=None):
        config = self.configs[0]
        path = (
            "/accounts/"
            + config["account_id"]
            + "/workers/scripts/"
            + (script or config["name"])
            + "/versions/"
            + VERSION
        )
        return self.values[path]["resources"]["bindings"]

    def binding(self, name):
        return next(item for item in self.bindings() if item["name"] == name)

    def schedules(self):
        config = self.configs[0]
        return self.values[
            "/accounts/"
            + config["account_id"]
            + "/workers/scripts/"
            + config["name"]
            + "/schedules"
        ]


class DriftAcceptance(unittest.TestCase):
    def fixture(self, app="watch"):
        fixture = ProviderFixture(app)
        environment = {
            "GITHUB_REPOSITORY": fixture.profile["repository"],
            "GITHUB_RUN_ID": "1",
            **fixture.operational,
        }
        active = patch.dict(os.environ, environment)
        active.start()
        self.addCleanup(active.stop)
        record(ROOT, app, SHA, fixture.cloud, fixture.github)
        fixture.requests.clear()
        return fixture

    def check(self, fixture, *, check_only=False):
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(
                ROOT, fixture.app, SHA, True, fixture.cloud, fixture.github, check_only
            )
        return required, json.loads(output.getvalue())

    def assert_readonly(self, fixture):
        self.assertTrue(fixture.requests)
        self.assertTrue(all(method == "GET" for _, method, _ in fixture.requests))

    def test_clean_last_good_is_readonly_and_never_requests_redeployment(self):
        fixture = self.fixture()
        required, result = self.check(fixture)
        self.assertFalse(required)
        self.assertEqual(result, {"state": "clean", "changes": []})
        self.assert_readonly(fixture)
        self.assertEqual(len(fixture.deployments), 1)

    def test_keyless_release_accepts_only_the_exact_retained_csrf_secret(self):
        for app in ("dashboard", "links", "watch", "mailsort", "recall", "tasks", "todofy", "model-router"):
            with self.subTest(app=app):
                _, _, _, desired = release_inputs(ROOT, app)
                worker = "home" if app == "dashboard" else app
                binding = next(item for item in desired[worker]["bindings"]
                               if item["name"] == "CSRF_SIGNING_KEY")
                self.assertEqual(binding, {"name": "CSRF_SIGNING_KEY", "type": "secret_text", "optional": True})
        fixture = self.fixture("dashboard")
        retained = {"name": "CSRF_SIGNING_KEY", "type": "secret_text"}
        fixture.bindings().append(retained)
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github)
        self.assertTrue(required)
        self.assertEqual(json.loads(output.getvalue()), {"state": "clean", "changes": []})
        fixture.bindings().remove(retained)
        fixture.bindings().append({"name": "CSRF_SIGNING_KEY_EXTRA", "type": "secret_text"})
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"):
            preflight(ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github)
        self.assert_readonly(fixture)

    def test_retired_model_connections_are_optional_live_bindings_only(self):
        for app, worker, names in (
            ("todofy", "todofy-core", ["GEMINI_API_KEY"]),
            ("mailsort", "mailsort", ["ANTHROPIC_API_KEY", "CODEX_ENDPOINT_TOKEN", "CODEX_ACCESS_CLIENT_ID", "CODEX_ACCESS_CLIENT_SECRET"]),
        ):
            _, _, _, desired = release_inputs(ROOT, app)
            for name in names:
                with self.subTest(worker=worker, name=name):
                    binding = next(item for item in desired[worker]["bindings"] if item["name"] == name)
                    self.assertEqual(binding, {"name": name, "type": "secret_text", "optional": True})
        fixture = self.fixture("todofy")
        fixture.bindings("todofy-core").append({"name": "GEMINI_API_KEY", "type": "secret_text"})
        output = io.StringIO()
        with redirect_stdout(output):
            preflight(ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github)
        self.assertEqual(json.loads(output.getvalue()), {"state": "clean", "changes": []})
        fixture.bindings("todofy-core").append({"name": "GEMINI_API_KEY_EXTRA", "type": "secret_text"})
        with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"):
            preflight(ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github)
        self.assert_readonly(fixture)

    def test_cron_service_and_domain_drift_are_detected_before_publishing(self):
        fixture = self.fixture()
        original = deepcopy(fixture.values)
        fixture.schedules().append({"cron": "* * * * *"})
        fixture.binding("TASKS")["props"] = {"source": "synthetic-private-source"}
        fixture.values[fixture.domain_path] = []
        required, result = self.check(fixture, check_only=True)
        self.assertFalse(required)
        self.assertEqual(result["state"], "repairable")
        self.assertEqual(
            {item["reason"] for item in result["changes"]},
            {
                "SCHEDULE_CHANGED",
                "BINDING_TARGET_CHANGED",
                "CUSTOM_DOMAIN_CHANGED",
            },
        )
        self.assertNotIn("synthetic-private-source", json.dumps(result))
        self.assert_readonly(fixture)
        self.assertTrue(self.check(fixture)[0])
        # Simulate the existing Wrangler publisher, then exercise the real readback recorder.
        fixture.values = original
        base = (
            "/accounts/"
            + fixture.resources["account_id"]
            + "/workers/scripts/"
            + fixture.configs[0]["name"]
        )
        published_version = "b1234567-1234-4234-8234-123456789abc"
        fixture.values[base + "/versions/" + published_version] = deepcopy(
            fixture.values[base + "/versions/" + VERSION]
        )
        fixture.values[base + "/deployments"]["deployments"][0]["versions"][0][
            "version_id"
        ] = published_version
        proof = record(ROOT, fixture.app, SHA, fixture.cloud, fixture.github)
        self.assertTrue(proof["verified"])
        self.assertFalse(self.check(fixture)[0])
        self.assertEqual(fixture.deployments[-1]["sha"], SHA)
        self.assertEqual(
            fixture.deployments[-1]["payload"]["workers"][0]["version_id"],
            published_version,
        )
        self.assertEqual(
            fixture.statuses[proof["deployment_id"]][0]["state"], "success"
        )

    def test_bad_physical_readback_cannot_create_a_successful_deployment(self):
        fixture = self.fixture()
        fixture.binding("TASKS")["service"] = "another-worker"
        with self.assertRaisesRegex(ReleaseError, "WORKER_CONFIGURATION_NOT_VERIFIED"):
            record(ROOT, fixture.app, SHA, fixture.cloud, fixture.github)
        self.assertEqual(len(fixture.deployments), 1)
        self.assert_readonly(fixture)

    def test_stateful_secret_and_operational_changes_require_manual_action(self):
        fixture = self.fixture("mail-hero")
        original = deepcopy(fixture.values)
        for field, change in (
            ("DB", {"id": "11111111-2222-4333-8444-555555555555"}),
            ("MAIL_STORE", {"bucket_name": "synthetic-other-bucket"}),
            ("COORDINATOR", {"namespace_id": "0" * 32}),
            ("FORCE_SEND_PAUSED", {"text": "true"}),
            ("CREDENTIAL_KEY", None),
        ):
            with self.subTest(field=field):
                fixture.values = deepcopy(original)
                if change is None:
                    fixture.bindings().remove(fixture.binding(field))
                else:
                    fixture.binding(field).update(change)
                with (
                    redirect_stdout(io.StringIO()),
                    self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
                ):
                    self.check(fixture)
        self.assert_readonly(fixture)
        self.assertEqual(len(fixture.deployments), 1)

    def test_same_bucket_name_recreated_later_is_not_the_accepted_store(self):
        fixture = self.fixture("mail-hero")
        bucket = fixture.configs[0]["r2_buckets"][0]["bucket_name"]
        fixture.values[
            "/accounts/" + fixture.resources["account_id"] + "/r2/buckets/" + bucket
        ]["creation_date"] = "2026-10-04T00:00:00Z"
        with self.assertRaisesRegex(
            ReleaseError, "PERSISTENT_RESOURCE_IDENTITY_CHANGED"
        ):
            self.check(fixture)
        self.assert_readonly(fixture)

    def test_owner_operational_update_is_allowed_only_in_normal_publication(self):
        fixture = self.fixture("mail-hero")
        fixture.binding("FORCE_SEND_PAUSED")["text"] = "true"
        with (
            redirect_stdout(io.StringIO()),
            self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
        ):
            self.check(fixture)
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(
                ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github
            )
        self.assertTrue(required)
        self.assertEqual(
            json.loads(output.getvalue())["changes"],
            [
                {
                    "script": "mail-hero",
                    "field": "FORCE_SEND_PAUSED",
                    "reason": "OPERATIONAL_RELEASE_UPDATE",
                }
            ],
        )
        self.assert_readonly(fixture)
        with self.assertRaisesRegex(ReleaseError, "WORKER_CONFIGURATION_NOT_VERIFIED"):
            record(ROOT, fixture.app, SHA, fixture.cloud, fixture.github)
        self.assertEqual(len(fixture.deployments), 1)
        fixture.binding("FORCE_SEND_PAUSED")["text"] = "false"
        self.assertTrue(
            record(ROOT, fixture.app, SHA, fixture.cloud, fixture.github)["verified"]
        )

    def test_unowned_domain_is_preserved_and_reported_manual(self):
        fixture = self.fixture()
        fixture.values[fixture.domain_path][0]["service"] = "external-worker"
        before = deepcopy(fixture.values)
        with (
            redirect_stdout(io.StringIO()),
            self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
        ):
            self.check(fixture)
        self.assertEqual(fixture.values, before)
        self.assert_readonly(fixture)

    def test_normal_relay_release_retires_only_the_exact_old_inputs(self):
        fixture = self.fixture("website-relay")
        retired = {
            "NOTION_TOKEN": "secret_text",
            "NOTION_DATA_SOURCE_ID": "secret_text",
            "NOTION_WEBHOOK_SECRET": "secret_text",
            "NOTION_API_VERSION": "plain_text",
            "AUTO_PUBLISH": "plain_text",
            "QUIET_MINUTES": "plain_text",
            "MAX_AUTO_RELEASES_PER_DAY": "plain_text",
            "RECONCILE_UTC_HOUR": "plain_text",
            "IGNORED_EDITOR_IDS": "plain_text",
        }
        fixture.bindings().extend(
            {"name": name, "type": kind, "text": "synthetic-private-input"}
            for name, kind in retired.items()
        )
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(
                ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github
            )
        result = json.loads(output.getvalue())
        self.assertTrue(required)
        self.assertEqual(result["state"], "repairable")
        self.assertEqual({item["field"] for item in result["changes"]}, set(retired))
        self.assertEqual(
            {item["reason"] for item in result["changes"]},
            {"LEGACY_WEBSITE_BINDING_RETIRED"},
        )
        self.assertNotIn("synthetic-private-input", output.getvalue())
        self.assert_readonly(fixture)
        self.assertEqual(fixture.binding("GITHUB_DISPATCH_TOKEN")["type"], "secret_text")

    def test_relay_retirement_does_not_allow_unknown_bindings_or_repairs(self):
        for app, repair, name in (
            ("website-relay", False, "NOTION_TOKEN_EXTRA"),
            ("website-relay", False, "notion_token"),
            ("website-relay", True, "NOTION_TOKEN"),
            ("watch", False, "NOTION_TOKEN"),
        ):
            with self.subTest(app=app, repair=repair, name=name):
                fixture = self.fixture(app)
                fixture.bindings().append({"name": name, "type": "secret_text"})
                output = io.StringIO()
                with (
                    redirect_stdout(output),
                    self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
                ):
                    preflight(ROOT, app, SHA, repair, fixture.cloud, fixture.github)
                self.assertEqual(
                    json.loads(output.getvalue())["changes"],
                    [{"script": fixture.configs[0]["name"], "field": name,
                      "reason": "BINDING_UNDECLARED"}],
                )
                self.assert_readonly(fixture)

    def test_a_retired_binding_is_one_the_app_no_longer_declares(self):
        # Only these exact owner-approved retirements may pass a normal release.
        self.assertEqual(control.RETIRED_BINDINGS, {
            "todofy": {"TASKS", "GEMINI_API_BASE", "GEMINI_EMAIL_MODELS", "GEMINI_MODELS"},
            "mailsort": {"AI", "CODEX_ENDPOINT_URL"},
        })
        for app, names in control.RETIRED_BINDINGS.items():
            for path in control.WORKERS[app]:
                config = control.read_toml(ROOT / path)
                declared = set(config.get("vars", {})) | {service["binding"] for service in config.get("services", [])}
                if "binding" in config.get("ai", {}):
                    declared.add(config["ai"]["binding"])
                with self.subTest(app=app, path=path):
                    self.assertFalse(names & declared)

    def test_normal_todofy_release_retires_legacy_gemini_configuration(self):
        fixture = self.fixture("todofy")
        bindings = fixture.bindings("todofy-core")
        bindings[:] = [item for item in bindings if item["name"] != "MODEL_ROUTER"]
        retired = {
            "GEMINI_API_BASE": "https://synthetic-model-api.example",
            "GEMINI_EMAIL_MODELS": "synthetic-email",
            "GEMINI_MODELS": "synthetic-report,synthetic-fallback",
        }
        bindings.extend({"name": name, "type": "plain_text", "text": value}
                        for name, value in retired.items())
        for script in ("todofy-core", "todofy"):
            next(item for item in fixture.bindings(script) if item["name"] == "BUILD_SHA")["text"] = "b" * 40
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(ROOT, "todofy", SHA, False, fixture.cloud, fixture.github)
        self.assertTrue(required)
        result = json.loads(output.getvalue())
        self.assertEqual(result["state"], "repairable")
        self.assertEqual({(item["script"], item["field"]): item["reason"] for item in result["changes"]}, {
            ("todofy-core", "MODEL_ROUTER"): "BINDING_MISSING",
            **{("todofy-core", name): "RETIRED_BINDING" for name in retired},
            ("todofy-core", "BUILD_SHA"): "BUILD_IDENTITY_CHANGED",
            ("todofy", "BUILD_SHA"): "BUILD_IDENTITY_CHANGED",
        })
        for value in retired.values():
            self.assertNotIn(value, output.getvalue())
        self.assert_readonly(fixture)

    def test_gemini_configuration_retirement_still_blocks_repairs_and_other_names(self):
        for app, repair, name in (
            ("todofy", True, "GEMINI_MODELS"),
            ("todofy", False, "GEMINI_MODELS_EXTRA"),
            ("todofy", False, "gemini_models"),
            ("watch", False, "GEMINI_MODELS"),
        ):
            with self.subTest(app=app, repair=repair, name=name):
                fixture = self.fixture(app)
                script = "todofy-core" if app == "todofy" else fixture.configs[0]["name"]
                fixture.bindings(script).append({"name": name, "type": "plain_text", "text": "synthetic"})
                with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"):
                    preflight(ROOT, app, SHA, repair, fixture.cloud, fixture.github)
                self.assert_readonly(fixture)

    @patch.dict("control.RETIRED_BINDINGS", {"dashboard": {"OLD_APP"}})
    def test_normal_home_release_removes_a_retired_binding(self):
        fixture = self.fixture("dashboard")
        fixture.bindings().append(
            {"name": "OLD_APP", "type": "service", "service": "old-app", "entrypoint": "Ops",
             "environment": "production"}
        )
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(
                ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github
            )
        self.assertTrue(required)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"state": "repairable", "changes": [
                {"script": "home", "field": "OLD_APP", "reason": "RETIRED_BINDING"},
            ]},
        )
        self.assert_readonly(fixture)

    @patch.dict("control.RETIRED_BINDINGS", {"dashboard": {"OLD_APP"}})
    def test_service_retirement_does_not_allow_other_bindings_apps_or_repairs(self):
        for app, repair, name in (
            ("dashboard", True, "OLD_APP"),
            ("dashboard", False, "OLD_APP_EXTRA"),
            ("dashboard", False, "old_app"),
            ("watch", False, "OLD_APP"),
        ):
            with self.subTest(app=app, repair=repair, name=name):
                fixture = self.fixture(app)
                fixture.bindings().append(
                    {"name": name, "type": "service", "service": "old-app",
                     "environment": "production"}
                )
                output = io.StringIO()
                with (
                    redirect_stdout(output),
                    self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
                ):
                    preflight(ROOT, app, SHA, repair, fixture.cloud, fixture.github)
                self.assertEqual(
                    json.loads(output.getvalue())["changes"],
                    [{"script": fixture.configs[0]["name"], "field": name,
                      "reason": "BINDING_UNDECLARED"}],
                )
                self.assert_readonly(fixture)

    def test_normal_mailsort_release_removes_only_the_retired_ai_binding(self):
        fixture = self.fixture("mailsort")
        fixture.bindings().append({"name": "AI", "type": "ai"})
        fixture.binding("BUILD_SHA")["text"] = "b" * 40
        output = io.StringIO()
        with redirect_stdout(output):
            required = preflight(ROOT, "mailsort", SHA, False, fixture.cloud, fixture.github)
        self.assertTrue(required)
        self.assertEqual(json.loads(output.getvalue()), {
            "state": "repairable", "changes": [
                {"script": "mailsort", "field": "AI", "reason": "RETIRED_BINDING"},
                {"script": "mailsort", "field": "BUILD_SHA", "reason": "BUILD_IDENTITY_CHANGED"},
            ],
        })
        self.assert_readonly(fixture)

    def test_ai_retirement_does_not_allow_other_bindings_apps_or_repairs(self):
        for app, repair, name in (
            ("mailsort", True, "AI"),
            ("mailsort", False, "AI_EXTRA"),
            ("mailsort", False, "ai"),
            ("watch", False, "AI"),
        ):
            with self.subTest(app=app, repair=repair, name=name):
                fixture = self.fixture(app)
                fixture.bindings().append({"name": name, "type": "ai"})
                output = io.StringIO()
                with (
                    redirect_stdout(output),
                    self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
                ):
                    preflight(ROOT, app, SHA, repair, fixture.cloud, fixture.github)
                self.assertEqual(json.loads(output.getvalue())["changes"], [
                    {"script": fixture.configs[0]["name"], "field": name,
                     "reason": "BINDING_UNDECLARED"},
                ])
                self.assert_readonly(fixture)

    def test_a_release_stops_for_a_repair_or_an_undeclared_secret(self):
        for repair, name, kind in (
            (True, "TASK_SOURCE", "plain_text"),
            (False, "RETIRED_API_KEY", "secret_text"),
        ):
            with self.subTest(repair=repair, name=name):
                fixture = self.fixture("todofy")
                fixture.bindings("todofy-core").append({"name": name, "type": kind})
                output = io.StringIO()
                with (
                    redirect_stdout(output),
                    self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
                ):
                    preflight(ROOT, "todofy", SHA, repair, fixture.cloud, fixture.github)
                self.assertEqual(
                    json.loads(output.getvalue())["changes"],
                    [{"script": "todofy-core", "field": name, "reason": "BINDING_UNDECLARED"}],
                )
                self.assert_readonly(fixture)

    def test_retirement_requires_the_new_daily_relay_configuration(self):
        fixture = self.fixture("website-relay")
        fixture.bindings().append({"name": "NOTION_TOKEN", "type": "secret_text"})
        configs = deepcopy(fixture.configs)
        del configs[0]["vars"]["DAILY_SYNC_CRON"]
        with (
            patch("control.release_inputs", return_value=(
                fixture.profile, fixture.resources, configs, fixture.desired,
            )),
            redirect_stdout(io.StringIO()),
            self.assertRaisesRegex(ReleaseError, "REPAIR_MANUAL_REQUIRED"),
        ):
            preflight(ROOT, fixture.app, SHA, False, fixture.cloud, fixture.github)
        self.assert_readonly(fixture)


if __name__ == "__main__":
    unittest.main()
