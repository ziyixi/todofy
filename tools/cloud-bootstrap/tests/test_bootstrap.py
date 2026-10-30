"""Synthetic bootstrap checks: account scoping, secret reuse and read-only adoption."""

import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).absolute().parents[3]
sys.path[:0] = [str(ROOT / "tools/cloud-bootstrap"), str(ROOT / "infra/scripts"), str(ROOT / "tools/cloud-config")]
import adopt_metadata
import cloud_api
import github_config
import github_secrets
import bootstrap_inventory as inventory
import finalize
import private_input
import state_imports
import tofu_bootstrap
from private_input import BootstrapError

ACCOUNT, ZONE = "a" * 32, "b" * 32


class CommandLine(unittest.TestCase):
    def test_help_imports_in_a_fresh_process_without_private_input(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools/cloud-bootstrap/bootstrap.py"), "--help"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--private-file", result.stdout)
        self.assertIn("fresh,adopt,extend", result.stdout)


class PrivateInput(unittest.TestCase):
    def test_keys_generate_once_and_adoption_never_fills_unknown_keys(self):
        value = {"infra_values": {"access_owner_emails": ["owner" + "@" + "example.invalid"]}}
        first = private_input.generated_secrets(value)
        value["github_secrets"] = first
        self.assertEqual(private_input.generated_secrets(value), first)
        self.assertFalse(any(name.endswith("_CSRF_SIGNING_KEY") for name in first))
        adopted = private_input.generated_secrets({"github_secrets": {"MAIL_HERO_CREDENTIAL_KEY": "existing"}}, generate=False)
        self.assertEqual(adopted, {"MAIL_HERO_CREDENTIAL_KEY": "existing"})

    def test_existing_vps_keys_and_env_survive(self):
        value = {"vps": {"newsletter_env": {"SMTP_PASSWORD": "existing-smtp", "NEWSLETTER_EDITOR_TOKEN": "existing-editor"},
                         "platform_env": {"PLATFORM_DEPLOY_TOKEN": "existing-deploy"}, "fleet_key": "existing-hmac"}}
        configured = private_input.generated_secrets(value)
        vps = private_input.vps_credentials(value, configured, "new-connector")
        self.assertEqual(vps["newsletter_env"]["SMTP_PASSWORD"], "existing-smtp")
        self.assertEqual(vps["newsletter_env"]["NEWSLETTER_EDITOR_TOKEN"], "existing-editor")
        self.assertEqual(vps["platform_env"]["PLATFORM_DEPLOY_TOKEN"], "existing-deploy")
        self.assertEqual(vps["fleet_key"], "existing-hmac")

    def test_gateway_private_input_keeps_only_the_independent_inference_token(self):
        value = {"vps": {"codex_gateway_env": {"CODEX_GATEWAY_TOKEN": "existing-inference"}}}
        configured = private_input.generated_secrets(value)
        vps = private_input.vps_credentials(value, configured, "connector")
        self.assertEqual(vps["codex_gateway_env"], value["vps"]["codex_gateway_env"])
        value["vps"]["codex_gateway_env"]["PLATFORM_DEPLOY_TOKEN"] = "forbidden"
        with self.assertRaisesRegex(BootstrapError, "VPS_PRIVATE_INPUT_INVALID"):
            private_input.vps_credentials(value, configured, "connector")

    def test_private_files_refuse_repo_and_non_owner_permissions(self):
        with self.assertRaises(BootstrapError):
            private_input.write_private(ROOT / "secret.json", {}, ROOT)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private.json"
            private_input.write_private(path, {"version": 1}, ROOT)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(private_input.read_private(path, ROOT), {"version": 1})
            path.chmod(0o644)
            with self.assertRaises(BootstrapError):
                private_input.read_private(path, ROOT)

    def test_regular_token_file_is_read_without_public_output(self):
        with tempfile.TemporaryDirectory() as directory:
            token, source = Path(directory) / "token", Path(directory) / "private.json"
            token.write_text("synthetic-private-token\n")
            token.chmod(0o600)
            private_input.write_private(source, {"version": 1, "cloudflare_api_token_file": str(token)}, ROOT)
            self.assertEqual(private_input.read_private(source, ROOT)["cloudflare_api_token"], "synthetic-private-token")
            token.chmod(0o644)
            with self.assertRaisesRegex(BootstrapError, "PERMISSIONS_INVALID"):
                private_input.read_private(source, ROOT)

    def test_notion_read_credentials_belong_only_to_website_actions(self):
        result = private_input.generated_secrets({"github_secrets": {
            "WEBSITE_NOTION_TOKEN": "synthetic-notion", "WEBSITE_NOTION_DATA_SOURCE_ID": "synthetic-source"}}, generate=False)
        self.assertEqual(result["WEBSITE_NOTION_TOKEN"], "synthetic-notion")
        self.assertEqual(result["WEBSITE_NOTION_DATA_SOURCE_ID"], "synthetic-source")
        self.assertNotIn("WEBSITE_RELAY_NOTION_WEBHOOK_SECRET", result)


class GitHub(unittest.TestCase):
    def test_secret_value_is_only_on_stdin(self):
        calls = []

        def run(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return SimpleNamespace(returncode=0)

        github_secrets.set_production("owner/cloud", {"PRIVATE_KEY": "synthetic-hidden-key"}, run)
        arguments, options = calls[0]
        self.assertNotIn("synthetic-hidden-key", " ".join(arguments))
        self.assertEqual(options["input"], b"synthetic-hidden-key")

    def test_worker_maps_require_names_and_preserve_existing_keys(self):
        specs = {"app": {"github_secret": "APP_WORKER_SECRETS", "required": ["KEY"], "optional": []}}
        maps, missing = github_secrets.worker_secret_values({}, {}, specs)
        self.assertEqual(missing, ["app.KEY"])
        self.assertEqual(github_secrets.worker_secret_values({}, {}, specs, complete=False), ({}, []))
        maps, missing = github_secrets.worker_secret_values({"worker_secrets": {"app": {"KEY": "existing"}}}, {}, specs)
        self.assertEqual(json.loads(maps["APP_WORKER_SECRETS"]), {"KEY": "existing"})
        self.assertFalse(missing)

    def test_worker_maps_drop_only_the_exact_retired_csrf_binding(self):
        specs = {"links": {"github_secret": "LINKS_WORKER_SECRETS", "required": ["KEY"], "optional": []}}
        private = {"worker_secrets": {"links": {"KEY": "existing", "CSRF_SIGNING_KEY": 7}}}
        maps, missing = github_secrets.worker_secret_values(private, {}, specs)
        self.assertEqual(json.loads(maps["LINKS_WORKER_SECRETS"]), {"KEY": "existing"})
        self.assertEqual(private["worker_secrets"]["links"]["CSRF_SIGNING_KEY"], 7)
        self.assertFalse(missing)
        for name in ("csrf_signing_key", "CSRF_SIGNING_KEY_EXTRA", "UNDECLARED"):
            value = {"worker_secrets": {"links": {"KEY": "existing", "CSRF_SIGNING_KEY": "retired", name: "synthetic-private"}}}
            with self.subTest(name=name), self.assertRaises(BootstrapError) as caught:
                github_secrets.worker_secret_values(value, {}, specs)
            self.assertEqual(str(caught.exception), "WORKER_SECRET_NAME_INVALID")
            self.assertNotIn("synthetic-private", str(caught.exception))
        with self.assertRaises(BootstrapError) as caught:
            github_secrets.worker_secret_values({"worker_secrets": {"links": {"KEY": 7}}}, {}, specs)
        self.assertEqual(str(caught.exception), "WORKER_SECRET_VALUE_INVALID")

    def test_a_borrowed_owner_identity_never_writes_or_replaces_a_map(self):
        """The Newsletter console borrows Home's owner identity (cloud_profile identity_from): bootstrap writes Home's
        map as before and none for the console, so the console never gets a GitHub secret and Home's map is never
        replaced by the identity alone."""
        import cloud_profile

        specs = cloud_profile.worker_secret_specs(ROOT)
        self.assertEqual(specs["newsletter-console"]["github_secret"], specs["home"]["github_secret"])
        scalar = {"DASHBOARD_ACCESS_OWNER": "owner@example.test", "DASHBOARD_CF_ANALYTICS_TOKEN": "synthetic-analytics"}
        maps, missing = github_secrets.worker_secret_values({}, scalar, specs, complete=False)
        self.assertEqual(maps, {})
        maps, missing = github_secrets.worker_secret_values({"worker_secrets": {"home": {}}}, scalar, specs, complete=False)
        self.assertEqual(json.loads(maps["DASHBOARD_WORKER_SECRETS"]),
                         {"ACCESS_OWNER": "owner@example.test", "CF_ANALYTICS_TOKEN": "synthetic-analytics"})
        self.assertNotIn("NEWSLETTER_CONSOLE_WORKER_SECRETS", maps)
        maps, missing = github_secrets.worker_secret_values({}, scalar, specs)
        self.assertNotIn("NEWSLETTER_CONSOLE_WORKER_SECRETS", maps)
        self.assertFalse([name for name in missing if name.startswith("newsletter-console.")])
        with self.assertRaises(BootstrapError) as caught:
            github_secrets.worker_secret_values({"worker_secrets": {"newsletter-console": {"ACCESS_OWNER": "synthetic-private"}}},
                                                scalar, specs, complete=False)
        self.assertEqual(str(caught.exception), "WORKER_SECRETS_INVALID")
        self.assertNotIn("synthetic-private", str(caught.exception))

    def test_owner_machine_secrets_never_reach_github(self):
        specs = {"app": {"github_secret": "APP_WORKER_SECRETS", "required": ["KEY"], "optional": []}}
        owner_machine = {"app": ["GRANT_TOKEN"]}
        maps, missing = github_secrets.worker_secret_values(
            {"worker_secrets": {"app": {"KEY": "existing"}}}, {}, specs, owner_machine=owner_machine)
        self.assertEqual(json.loads(maps["APP_WORKER_SECRETS"]), {"KEY": "existing"})
        for private, scalar in (({"worker_secrets": {"app": {"KEY": "existing", "GRANT_TOKEN": "synthetic-grant"}}}, {}),
                                ({"worker_secrets": {"app": {"KEY": "existing"}}}, {"APP_GRANT_TOKEN": "synthetic-grant"})):
            with self.subTest(private=sorted(private["worker_secrets"]["app"]), scalar=sorted(scalar)), \
                    self.assertRaises(github_secrets.BootstrapError) as caught:
                github_secrets.worker_secret_values(private, scalar, specs, owner_machine=owner_machine)
            self.assertEqual(str(caught.exception), "WORKER_SECRET_OWNER_MACHINE_ONLY")
            self.assertNotIn("synthetic-grant", str(caught.exception))

    def test_bootstrap_refuses_the_mailsort_gmail_grant_from_the_repository_declarations(self):
        import cloud_profile

        specs = cloud_profile.worker_secret_specs(ROOT)
        owner_machine = cloud_profile.owner_machine_secrets(ROOT)
        for name in ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"):
            with self.subTest(name=name), self.assertRaises(github_secrets.BootstrapError):
                github_secrets.worker_secret_values({}, {"MAILSORT_" + name: "synthetic"}, specs, complete=False,
                                                    owner_machine=owner_machine)

    def test_migrated_and_router_provider_connections_never_enter_github(self):
        import cloud_profile

        specs = cloud_profile.worker_secret_specs(ROOT)
        owner_machine = cloud_profile.owner_machine_secrets(ROOT)
        retired = {
            "todofy-core": ["GEMINI_API_KEY"],
            "mailsort": ["ANTHROPIC_API_KEY", "CODEX_ENDPOINT_TOKEN", "CODEX_ACCESS_CLIENT_ID", "CODEX_ACCESS_CLIENT_SECRET"],
            "model-router": ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
        }
        for worker, names in retired.items():
            prefix = specs[worker]["github_secret"].removesuffix("_WORKER_SECRETS")
            for name in names:
                for private, scalar in (({"worker_secrets": {worker: {name: "synthetic-private-provider"}}}, {}),
                                        ({}, {prefix + "_" + name: "synthetic-private-provider"})):
                    with self.subTest(worker=worker, name=name), self.assertRaises(BootstrapError) as caught:
                        github_secrets.worker_secret_values(private, scalar, specs, complete=False, owner_machine=owner_machine)
                    self.assertEqual(str(caught.exception), "WORKER_SECRET_OWNER_MACHINE_ONLY")
                    self.assertNotIn("synthetic-private-provider", str(caught.exception))

    def test_new_environments_require_owner_review_and_pause_defaults(self):
        calls = []

        def api(path, method="GET", body=None, missing=False):
            calls.append((path, method, body))
            if path == "repos/owner/cloud":
                return {"default_branch": "main", "owner": {"id": 7, "type": "User"}}
            if method == "GET" and missing:
                return None
            if "/variables?" in path:
                return {"variables": []}
            return {}

        result = github_config.initialize("owner/cloud", call=api)
        review = next(body for path, method, body in calls if method == "PUT" and path.endswith("infra-review"))
        self.assertEqual(review["reviewers"], [{"type": "User", "id": 7}])
        self.assertIn("production", result["environments_created"])
        variables = {body["name"]: body["value"] for path, method, body in calls if method == "POST" and path.endswith("variables")}
        self.assertEqual(variables["TODOFY_PROCESSING_PAUSED"], "true")
        self.assertEqual(variables["MAIL_HERO_FORCE_SEND_PAUSED"], "true")
        self.assertEqual(variables["PERSONAL_CLOUD_AUTO_REPAIR"], "false")
        # Their deploy wrappers refuse a missing value.
        self.assertEqual(variables["MODEL_ROUTER_MAINTENANCE_MODE"], "false")

    def test_existing_protection_and_flags_are_never_overwritten(self):
        writes = []

        def api(path, method="GET", body=None, missing=False):
            if method != "GET":
                writes.append((path, method, body))
                return {}
            if path == "repos/owner/cloud":
                return {"default_branch": "main", "owner": {"id": 7, "type": "User"}}
            if "/variables?" in path:
                return {"variables": [{"name": name, "value": "operator-existing"} for name in github_config.DEFAULT_VARIABLES]}
            return {"protection_rules": [{"type": "required_reviewers"}]}

        self.assertEqual(github_config.initialize("owner/cloud", call=api), {"environments_created": [], "variables_created": []})
        self.assertFalse(writes)

    def test_adoption_preserves_an_absent_website_schedule_flag(self):
        writes = []

        def api(path, method="GET", body=None, missing=False):
            if method != "GET":
                writes.append(body)
                return {}
            if path == "repos/owner/cloud":
                return {"default_branch": "main", "owner": {"id": 7, "type": "User"}}
            if "/variables?" in path:
                return {"variables": []}
            return {"protection_rules": [{"type": "required_reviewers"}]}

        result = github_config.initialize("owner/cloud", mode="adopt", call=api)
        self.assertNotIn("WEBSITE_SCHEDULED_RECONCILE", result["variables_created"])
        self.assertNotIn("WEBSITE_SCHEDULED_RECONCILE", [body["name"] for body in writes])


class Cloud(unittest.TestCase):
    def test_foreign_zone_account_stops_before_mutation(self):
        calls = []

        def fetch(token, path, method="GET", body=None):
            calls.append(method)
            return {"id": ZONE, "name": "example.invalid", "account": {"id": "c" * 32}}

        with self.assertRaisesRegex(BootstrapError, "TARGET_MISMATCH"):
            cloud_api.verify_target("synthetic", ACCOUNT, ZONE, "example.invalid", fetch)
        self.assertEqual(calls, ["GET"])

    def test_state_bucket_uses_explicit_account(self):
        calls = []
        cloud_api.create_state_bucket("synthetic", ACCOUNT, lambda *args: calls.append(args))
        self.assertEqual(calls[0][1:], ("/accounts/" + ACCOUNT + "/r2/buckets", "POST", {"name": "infra-state"}))

    def test_existing_workers_subdomain_is_never_renamed(self):
        calls = []

        def fetch(token, path, method="GET", body=None):
            calls.append(method)
            return {"subdomain": "existing"}

        with self.assertRaisesRegex(BootstrapError, "SUBDOMAIN_MISMATCH"):
            cloud_api.ensure_workers_subdomain("synthetic", ACCOUNT, "desired", True, fetch)
        self.assertEqual(calls, ["GET"])

    def test_mail_rule_requires_exact_dedicated_inbox_domain(self):
        adopt_metadata.validate_address("receive" + "@inbox.example.invalid", "example.invalid")
        for value in ("receive" + "@example.invalid", "receive" + "@other.example.invalid", "x\n" + "@inbox.example.invalid"):
            with self.assertRaises(BootstrapError):
                adopt_metadata.validate_address(value, "example.invalid")

    def test_adopt_gate_only_allows_imports_and_noops(self):
        plan = {"resource_changes": [{"mode": "managed", "type": "cloudflare_zero_trust_access_policy",
                "address": "cloudflare_zero_trust_access_policy.owner", "change": {"actions": ["no-op"]}}]}
        tofu_bootstrap.bootstrap_gate(plan, "adopt")
        for action in (["create"], ["update"], ["delete"], ["delete", "create"]):
            plan["resource_changes"][0]["change"]["actions"] = action
            with self.assertRaises(BootstrapError):
                tofu_bootstrap.bootstrap_gate(plan, "adopt")

    def test_extend_creates_only_explicit_new_resources_and_never_updates_existing(self):
        address = 'cloudflare_d1_database.app["tasks"]'
        plan = {"resource_changes": [{"mode": "managed", "type": "cloudflare_d1_database",
                "address": address, "change": {"actions": ["create"]}}]}
        tofu_bootstrap.bootstrap_gate(plan, "extend", (address,))
        with self.assertRaisesRegex(BootstrapError, "EXTEND_UNEXPECTED_CREATE"):
            tofu_bootstrap.bootstrap_gate(plan, "extend", ('cloudflare_d1_database.app["other"]',))
        for actions in (["update"], ["delete"], ["delete", "create"]):
            plan["resource_changes"][0]["change"]["actions"] = actions
            with self.assertRaisesRegex(BootstrapError, "EXISTING_RESOURCE_CHANGE"):
                tofu_bootstrap.bootstrap_gate(plan, "extend", (address,))

    def test_adopt_plan_never_writes_state_or_creates_account_resources(self):
        plan = {"resource_changes": [{"mode": "managed", "type": "cloudflare_zero_trust_access_policy",
                "address": "cloudflare_zero_trust_access_policy.owner", "change": {"actions": ["no-op"]}}]}
        operations = []

        class Session:
            def __init__(self, **kwargs):
                self.work = kwargs["work"]
                assert not any(self.work.iterdir()), "session must start in an empty private directory"
                self.tofu = SimpleNamespace(init=lambda environment: operations.append("init"))

            def s3(self, method, key):
                operations.append(method)
                return 200, b""

            def plan_full(self, name):
                operations.append("plan")
                return 0, {"rows": [("no-op", "owner")]}, "", plan

            def cleanup(self):
                operations.append("cleanup")

        values = {"account_id": ACCOUNT, "access_owner_emails": ["owner"], "access_github_owner_emails": ["owner"],
                  "access_allowed_idp_ids": ["idp"], "access_github_idp_id": "idp"}
        private = {"infra_values": values, "cloudflare_api_token": "synthetic", "infra_state_passphrase": "synthetic-passphrase"}
        resources = {"account_id": ACCOUNT, "zone_id": ZONE, "managed_ids": {}, "standalone_access_app_ids": {}}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(tofu_bootstrap, "verify_target"), \
                mock.patch.object(tofu_bootstrap, "prepare"), mock.patch.object(tofu_bootstrap, "ensure_workers_subdomain") as workers:
            report, credentials = tofu_bootstrap.run(private, {"zone": "example.invalid", "workers_dev_subdomain": "desired"},
                                                     resources, "adopt", Path(directory), session_factory=Session, check_only=True)
            self.assertEqual(report, {"actions": {"no-op": 1}, "state_exists": True, "creates": []})
            self.assertFalse(credentials)
            self.assertEqual(workers.call_args.args[3], False)
            self.assertEqual(list(Path(directory).iterdir()), [])
        self.assertEqual(operations, ["HEAD", "HEAD", "init", "plan", "cleanup"])

    def test_inventory_does_not_export_private_attributes(self):
        plan = {"planned_values": {"outputs": {"access_aud": {"value": {"app": "public-audience"}},
                "d1_database_ids": {"value": {"app": "public-db"}}}, "root_module": {"resources": [{
                    "mode": "managed", "address": "cloudflare_zero_trust_access_service_token.platform_deploy",
                    "values": {"id": "public-id", "client_secret": "synthetic-hidden"}}]}}}
        previous = {"account_id": ACCOUNT, "zone_id": ZONE, "d1_databases": {}, "durable_objects": {}}
        self.assertNotIn("synthetic-hidden", json.dumps(inventory.exported_resources(previous, plan, fresh=True)))

    def test_watch_evidence_bucket_is_adopted_by_exact_name(self):
        imports = inventory.known_imports({"account_id": ACCOUNT, "zone_id": ZONE}, {})
        self.assertEqual(imports['cloudflare_r2_bucket.app["watch-evidence"]'], ACCOUNT + "/watch-evidence")

    def test_watch_evidence_extension_plans_a_create_without_importing_the_new_bucket(self):
        address = 'cloudflare_r2_bucket.app["watch-evidence"]'
        plan = {"resource_changes": [{"mode": "managed", "type": "cloudflare_r2_bucket",
                "address": address, "change": {"actions": ["create"]}}]}

        class Session:
            def __init__(self, **kwargs):
                imports = (kwargs["directory"] / "imports.tf").read_text()
                assert 'app["watch-evidence"]' not in imports
                assert 'app["mail-hero-store"]' in imports
                self.tofu = SimpleNamespace(init=lambda environment: None)

            def s3(self, method, key):
                return 200, b""

            def plan_full(self, name):
                return 2, {"rows": [("create", address)]}, "", plan

            def cleanup(self):
                pass

        values = {"account_id": ACCOUNT, "access_owner_emails": ["owner"], "access_github_owner_emails": ["owner"],
                  "access_allowed_idp_ids": ["idp"], "access_github_idp_id": "idp"}
        private = {"infra_values": values, "cloudflare_api_token": "synthetic",
                   "infra_state_passphrase": "synthetic-passphrase", "create_addresses": [address]}
        resources = {"account_id": ACCOUNT, "zone_id": ZONE}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(tofu_bootstrap, "verify_target"), \
                mock.patch.object(tofu_bootstrap, "prepare"), mock.patch.object(tofu_bootstrap, "ensure_workers_subdomain"), \
                mock.patch.object(tofu_bootstrap, "refuse_conflicts"):
            report, credentials = tofu_bootstrap.run(private, {"zone": "example.invalid", "workers_dev_subdomain": "desired"},
                                                     resources, "extend", Path(directory), session_factory=Session, check_only=True)
        self.assertEqual(report["creates"], [address])
        self.assertFalse(credentials)

    def test_fresh_and_adopt_inventory_retains_gateway_audience_and_drops_only_retired_backup(self):
        audiences = {"links": "worker-audience", "mail-hero": "mail-audience",
                     "codex-gateway": "gateway-audience", "mail-hero-backup": "legacy-audience", "unexpected": "unexpected-audience"}
        plan = {"planned_values": {"outputs": {"access_aud": {"value": audiences},
                "d1_database_ids": {"value": {}}}, "root_module": {"resources": []}}}
        previous = {"account_id": ACCOUNT, "zone_id": ZONE, "d1_databases": {}, "durable_objects": {}}
        for fresh in (True, False):
            with self.subTest(fresh=fresh):
                exported = inventory.exported_resources(previous, plan, fresh=fresh)
                self.assertEqual(exported["access_audiences"], {"links": "worker-audience",
                                 "mail-hero": "mail-audience", "codex-gateway": "gateway-audience", "unexpected": "unexpected-audience"})
        self.assertEqual(len(audiences), 5, "the full Terraform output remains available for drift checks")

    def test_only_missing_state_addresses_import_and_resume(self):
        calls = []
        session = SimpleNamespace(tofu=SimpleNamespace(run=lambda *args: calls.append(args) or 0),
                                  values_file=Path("/private/synthetic.tfvars"))
        imports = {"cloudflare_zero_trust_access_identity_provider.github[0]": "accounts/selected/id",
                   "cloudflare_zero_trust_access_application.mail_hero_backup[0]": "selected/legacy"}
        existing = {"cloudflare_zero_trust_access_application.mail_hero_backup"}
        with mock.patch.object(state_imports, "addresses", return_value=existing), \
                mock.patch.object(state_imports.infra_state, "backup_state") as backup:
            imported = state_imports.adopt(session, imports, True, {})
            backup.assert_called_once()
        self.assertEqual(imported, ["cloudflare_zero_trust_access_identity_provider.github[0]"])
        self.assertEqual(calls[0][0], "import")
        self.assertNotIn("apply", calls[0])
        with mock.patch.object(state_imports, "addresses", return_value=existing | set(imported)), \
                mock.patch.object(state_imports.infra_state, "backup_state") as backup:
            self.assertEqual(state_imports.adopt(session, imports, True, {}), [])
            backup.assert_not_called()

    def test_failed_import_keeps_only_sanitized_headlines_and_stops(self):
        address = 'cloudflare_d1_database.app["links"]'
        calls = []
        private_value = "sensitive-credential-" + "x" * 40
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "tofu.log"
            log.write_text('Error: Cannot import "' + private_value + '"\nprivate detail: ' + private_value)
            tofu = state_imports.infra_state.Tofu({}, log)
            tofu.run = lambda *args: calls.append(args) or 1
            session = SimpleNamespace(tofu=tofu, values_file=Path("/private/synthetic.tfvars"))
            with self.assertRaises(BootstrapError) as caught:
                state_imports.adopt(session, {address: "selected/id", "later": "selected/later"}, False, {})
        self.assertEqual(str(caught.exception), "BOOTSTRAP_IMPORT_FAILED")
        self.assertEqual(caught.exception.details, {"address": address, "headlines": ["Error: Cannot import <…>"]})
        self.assertNotIn(private_value, json.dumps(caught.exception.details))
        self.assertEqual(len(calls), 1)


class Finalize(unittest.TestCase):
    def test_first_releases_name_every_durable_object_namespace(self):
        # finalize requires the namespaces read from these apps' first releases to be exactly DO_KEYS, so an app missing
        # here stops every fresh or adopt rebuild with FIRST_RELEASE_NAMESPACE_MISSING, and a class missing from DO_KEYS
        # is never captured. The release units come from control.py (on sys.path through finalize), so the test reads
        # only finalize's APPS, however that is written.
        from control import WORKERS, read_toml

        bound = {binding["class_name"]
                 for app in finalize.APPS for path in WORKERS[app]
                 for binding in read_toml(ROOT / path).get("durable_objects", {}).get("bindings", [])}
        self.assertEqual(bound, set(finalize.DO_KEYS))


if __name__ == "__main__":
    unittest.main()
